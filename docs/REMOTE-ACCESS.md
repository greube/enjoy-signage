# Using ENJOY Signage from outside the church (free Cloudflare Tunnel)

This guide gives the admin panel a web address such as `https://signage.yourchurch.org`, so it works from home or a phone. It uses Cloudflare's free tunnel and login service:

- **No ports are opened on the church router.** The church's internet address stays hidden, and the server makes an outgoing connection to Cloudflare instead.
- **Nobody reaches the app without signing in.** Cloudflare asks for an email address on your list and sends a one-time code to it. After that, the app still asks for that person's own ENJOY Signage username and password.
- **The TVs don't change.** They keep using the local network address.

Everything here is free. The Zero Trust free plan covers up to 50 people.

---

## What you need

1. **A free Cloudflare account** at https://dash.cloudflare.com.
2. **A domain name managed by Cloudflare.**
   - If the church domain's DNS is already on Cloudflare, use a subdomain of it, e.g. `signage.yourchurch.org`.
   - If not, moving the church's main domain is a bigger job, best done with whoever manages the website and email. A simpler route is to register a cheap separate domain in Cloudflare: **Domain Registration → Register Domains**, which costs roughly $10–15 a year at cost price. It's managed by Cloudflare automatically.
3. **ENJOY Signage 1.8 or newer.** It has the safety checks for internet use, uploads of any size work through Cloudflare, and everyone has their own sign-in with lockout.
4. **User accounts set up.** Give each person their own account on the **Users** page.

---

## Step 1: Turn on Zero Trust (once)

1. In the Cloudflare dashboard, open **Zero Trust** from the left-hand menu.
2. Choose a *team name* (anything, e.g. `enjoychurch`), then pick the **Free** plan.
3. Cloudflare may ask for a payment method even for the free plan. You won't be charged on the Free plan.

## Step 2: Set up the login first

Set up the login before the address exists, so the address is never open even for a minute.

1. In **Zero Trust**, go to **Access → Applications → Add an application → Self-hosted**.
2. **Application name:** `ENJOY Signage`. **Session duration:** `24 hours` (or up to a week).
3. **Application domain:** subdomain `signage`, domain `yourchurch.org`. Leave **Path** empty, so the whole site is protected.
4. Under **Policies**, select **Create new policy**:
   - **Name:** `Signage admins`
   - **Action:** `Allow`
   - **Include → Emails:** add each person's email address
     - or **Emails ending in** `@yourchurch.org`, if everyone has a church address
5. Save the policy and the application.
6. Go to **Settings → Authentication → Login methods** and check **One-time PIN** is listed. If you like, also add **Google** or **Azure AD / Microsoft** so people can sign in with those accounts.

> **Don't add a "Bypass" rule.** Everything at this address should require a login. The TVs don't need it, because they use the local address.

## Step 3: Create the tunnel

1. In the Cloudflare dashboard, go to **Networking → Tunnels → Create a tunnel**. If your dashboard looks different, it's under **Zero Trust → Networks → Tunnels**.
2. Choose **Cloudflared**, name it `enjoy-signage`, and select **Save / Create tunnel**.
3. Choose the **operating system of the signage server**. Cloudflare then shows install commands containing a long secret token. Treat that token like a password.

### On a Windows server

1. Download the **64-bit Windows installer** linked on that page (`cloudflared-windows-amd64.msi`) and run it. It's signed by Cloudflare, so Smart App Control allows it.
2. Open **Command Prompt as administrator**: Start → type `cmd` → right-click → *Run as administrator*.
3. Paste the command Cloudflare shows. It looks like this:
   ```
   cloudflared.exe service install eyJhIjoi…your-token…
   ```
   This installs Cloudflare's connector as a Windows service, so it starts at boot.

### On an Ubuntu server

Copy the **Debian / Ubuntu** commands shown on that page into a terminal on the signage server. They add Cloudflare's software source and install `cloudflared`, then finish with:
```bash
sudo cloudflared service install eyJhIjoi…your-token…
```
This creates the `cloudflared` service, which starts at boot. Ubuntu's normal updates keep it up to date.

4. Back in the dashboard, wait until the connector shows **Connected** (usually under a minute), then select **Next / Continue**.

## Step 4: Point the address at ENJOY Signage

1. Open the tunnel → **Routes** tab → **Add route → Published application**. Older dashboards call this **Public Hostname**.
2. **Subdomain:** `signage`. **Domain:** `yourchurch.org`. Leave **Path** empty.
3. **Service:** `HTTP`, URL `localhost:3000`. Use your port if you changed it.
4. Save. Cloudflare creates the DNS record for you.

## Step 5: Test it

1. Turn **off** Wi-Fi on your phone, so it uses mobile data, and open `https://signage.yourchurch.org`.
2. You should see a **Cloudflare sign-in page**. Enter your email and you'll be emailed a code. If it doesn't arrive, check spam or junk.
3. Enter the code, then your ENJOY Signage username and password. You're in.
4. Try an address that **isn't** on your list. It should be refused after the code step.

---

## Day to day

- **Adding or removing people:** in **Zero Trust → Access → Applications → ENJOY Signage → Policies**, edit the email list. Removing someone takes effect when their current session ends (within the session duration you set). For an immediate lock-out, also disable their account on the Users page.
- **Uploads:** any size works. Large videos are sent in 48 MB pieces, and if the connection drops, the upload carries on from the last piece. It's still quicker on site.
- **TV links:** the admin panel always shows the **local** address (e.g. `http://192.168.1.20:3000/player/…`) for TVs, even when you're signed in remotely. TVs should never use the internet address.
- **Connecting Spotify remotely** works the same way as on site: after approving in Spotify, copy the `127.0.0.1…` address and paste it into the Setup page.
- **Switching remote access off:**
  - **Temporarily:** in the tunnel's **Routes** tab, delete the published application.
  - **Completely:** delete the tunnel, then remove the connector.
    - **Windows:** run `cloudflared.exe service uninstall` as administrator.
    - **Ubuntu:** run `sudo cloudflared service uninstall`.

## Troubleshooting

| What you see | What it means |
|---|---|
| **502 Bad Gateway** or **Error 1033** after signing in | The tunnel can't reach ENJOY Signage. Check the server is running (`church-signage status` on Ubuntu), and that the route's URL is `localhost:3000` (or your port). |
| The tunnel shows **Down / Inactive** | The connector service isn't running on the server. **Windows:** Services → *Cloudflared agent* → Start. **Ubuntu:** `sudo systemctl restart cloudflared`. The server also needs to reach the internet on port 7844. |
| The site opens **without** a Cloudflare sign-in | The Access application doesn't match the address. Check the subdomain and domain in Step 2 match Step 4 exactly, and that there's no Bypass rule. |
| No code email arrives | Check spam or junk, and check the address is on the policy list exactly. Mismatched addresses fail silently. |
| A change gives "Blocked: this change didn't come from the ENJOY Signage admin page" | The page is an old copy. Reload it. |

---

## Alternative: Tailscale (private, nothing public)

If only a few people need remote access, Tailscale is even simpler: no domain, and no public address at all.

1. Sign up at https://tailscale.com with a church Google or Microsoft account.
2. Install Tailscale on the signage server.
   - **Windows:** use the installer from tailscale.com.
   - **Ubuntu:** run `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`.
3. Sign in, then in the Tailscale admin console turn off **key expiry** for the server.
4. Install the Tailscale app on each admin's phone or laptop and invite them to your network (tailnet).
5. Optional, for a tidy HTTPS address: turn on **MagicDNS** and **HTTPS certificates** in the Tailscale admin console, then run `tailscale serve --bg 3000` on the server. Admins then use `https://<server-name>.<your-tailnet>.ts.net`.

People need the Tailscale app turned on to reach the admin panel. Uploads have no size limit.
