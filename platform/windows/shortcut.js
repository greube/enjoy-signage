'use strict';
/**
 * Writes Windows shortcut (.lnk) files with plain Node, following Microsoft's [MS-SHLLINK] format.
 *
 * Why not PowerShell or VBScript? With Smart App Control on, Windows blocks unsigned scripts and puts
 * PowerShell in Constrained Language mode, where the usual WScript.Shell shortcut trick isn't allowed.
 * A .lnk is just a small data file, so writing it ourselves always works.
 *
 * The target is stored the way Explorer does: a shell item list of My Computer → C:\ → each folder → the
 * file, every item carrying its full Unicode name. The byte layout matches the long-established pylnk3
 * library (verified byte-for-byte when this was written).
 */
const fs = require('fs');

const CLSID_SHELLLINK = Buffer.from('0114020000000000c000000000000046', 'hex');
const CLSID_MY_COMPUTER = Buffer.from('e04fd020ea3a6910a2d808002b30309d', 'hex'); // {20D04FE0-3AEA-1069-A2D8-08002B30309D}

const F = { HasLinkTargetIDList: 0x1, HasName: 0x4, HasWorkingDir: 0x10, HasArguments: 0x20, HasIconLocation: 0x40, IsUnicode: 0x80, ForceNoLinkInfo: 0x100 };
const SHOW = { normal: 1, maximized: 3, minimized: 7 }; // 7 = SW_SHOWMINNOACTIVE: starts minimised, doesn't steal focus

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const utf16z = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.alloc(2)]);
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

function dosDateTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return Buffer.concat([u16(date), u16(time)]);
}

/** One folder or file in the item list, with the 0xBEEF0004 extension block holding its full name. */
function segment(name, isFile, when) {
  const ascii = isAscii(name);
  const type = (isFile ? 0x32 : 0x31) + (ascii ? 0 : 4); // 0x35/0x36 = the short name is stored as Unicode
  let shortName;
  if (ascii) {
    shortName = Buffer.concat([Buffer.from(name, 'latin1'), Buffer.from([0])]);
    if (shortName.length % 2) shortName = Buffer.concat([shortName, Buffer.from([0])]); // keep 2-byte alignment
  } else shortName = utf16z(name);
  const dt = dosDateTime(when);
  return Buffer.concat([
    u16(type), u32(0) /* size */, dt, u16(0x10),
    shortName,
    u16(24 + 2 * name.length), u16(3), u16(4), u16(0xbeef), // extension: size, version 3, signature 0xBEEF0004
    dt, dt, // created, accessed
    u16(0x14), u16(0), // offset of the Unicode name; no localised name
    utf16z(name),
    u16(0x0e + shortName.length),
  ]);
}

function idList(target, when) {
  const m = /^([A-Za-z]):\\(.+)$/.exec(target);
  const parts = m[2].split('\\').filter(Boolean);
  const items = [
    Buffer.concat([Buffer.from([0x1f, 0x50]), CLSID_MY_COMPUTER]),
    Buffer.concat([Buffer.from([0x2f]), Buffer.from(m[1].toUpperCase() + ':\\', 'latin1'), Buffer.alloc(19)]),
    ...parts.map((p, i) => segment(p, i === parts.length - 1, when)),
  ];
  const list = Buffer.concat([...items.map((it) => Buffer.concat([u16(it.length + 2), it])), u16(0)]);
  return Buffer.concat([u16(list.length), list]);
}

const stringData = (s) => Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le')]);

/**
 * build({ target, args, workingDir, icon, iconIndex, description, show }) → Buffer
 * target must be a full Windows path to a file, such as C:\Program Files\nodejs\node.exe.
 */
function build(o) {
  if (!/^[A-Za-z]:\\.+/.test(o.target || '')) throw new Error(`Shortcut target must be a full path: ${o.target}`);
  let flags = F.HasLinkTargetIDList | F.IsUnicode | F.ForceNoLinkInfo;
  const strings = [];
  // StringData order is fixed by the format: name, (relative path), working dir, arguments, icon.
  if (o.description) { flags |= F.HasName; strings.push(stringData(o.description)); }
  if (o.workingDir) { flags |= F.HasWorkingDir; strings.push(stringData(o.workingDir)); }
  if (o.args) { flags |= F.HasArguments; strings.push(stringData(o.args)); }
  if (o.icon) { flags |= F.HasIconLocation; strings.push(stringData(o.icon)); }
  for (const s of [o.description, o.workingDir, o.args, o.icon]) if (s && s.length > 0xffff) throw new Error('Shortcut text too long');

  const header = Buffer.concat([
    u32(0x4c), CLSID_SHELLLINK, u32(flags),
    u32(0), // file attributes
    Buffer.alloc(24), // creation, access, write times
    u32(0), // file size
    u32(o.iconIndex || 0),
    u32(SHOW[o.show] || SHOW.normal),
    u16(0), u16(0), u32(0), u32(0), // hotkey, reserved
  ]);
  return Buffer.concat([header, idList(o.target, o.when || new Date()), ...strings, u32(0) /* no extra data */]);
}

/** Writes the shortcut file (via a temporary file, so a half-written shortcut never appears). */
function write(file, o) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, build(o));
  fs.renameSync(tmp, file);
}

module.exports = { build, write };
