# Deploying HealOps to a cloud VM

Exact, copy-pasteable commands to run HealOps on a single Ubuntu VM with a real HTTPS
URL. Written for Oracle Cloud's free-tier "Ampere A1" VM (ARM64, Ubuntu), but every step
after "create the VM" works the same on any Ubuntu 22.04+ VM from any cloud provider
(amd64 or arm64) - just skip the Oracle-specific notes.

You'll need: a cloud account, a [Gemini API key](https://ai.google.dev/), and a
[Groq API key](https://console.groq.com/). No domain name required - see step 4.

## 1. Create the VM

In the Oracle Cloud console: **Compute → Instances → Create instance**.

- **Image**: Ubuntu (22.04 or 24.04).
- **Shape**: click "Change shape" → **Ampere** → `VM.Standard.A1.Flex` → 2 OCPUs, 4 GB
  RAM (within the free tier's allowance). On another provider, any Ubuntu VM with
  **at least 4 GB RAM** works - e.g. a $20-24/mo "small" droplet/VM on most providers.
- **Networking**: let it create a new VCN/subnet if this is your first instance.
- **SSH keys**: let the console generate a key pair and download the private key (or
  paste in your own public key). You need this to log in.
- Create the instance, then note its **public IP address** on the instance's detail
  page.

Log in to confirm it works:

```bash
chmod 600 ~/Downloads/ssh-key-*.key     # the key you downloaded
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<server-ip>
```

(On another cloud provider, the username may be `ubuntu`, `root`, or `admin` - check
their docs. Everything below runs the same once you're logged in.)

## 2. Open ports 80 and 443

HealOps needs inbound HTTP (80, for the Let's Encrypt certificate check) and HTTPS
(443, the dashboard). This is a two-step process on Oracle Cloud: the cloud firewall
*and* the VM's own firewall both block traffic by default.

**a) Cloud firewall (Security List).** In the console: **Networking → Virtual cloud
networks → `<your VCN>` → Security Lists → `Default Security List`**. Click
**Add Ingress Rules** and add two rules (repeat for each):

| Source CIDR | IP Protocol | Destination Port Range |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(On another cloud provider, this is usually called a "security group" or "firewall
rule" - open inbound TCP 80 and 443 from anywhere the same way.)

**b) The VM's own firewall (iptables).** Oracle's Ubuntu images also run `iptables`
*inside* the VM with a restrictive default, so step (a) alone isn't enough - this is
the part people usually get stuck on. SSH into the VM and run:

```bash
sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save    # makes it survive a reboot
```

(If `netfilter-persistent` isn't found: `sudo apt-get update && sudo apt-get install -y iptables-persistent`,
then run the `save` command again. On a non-Oracle Ubuntu VM, `ufw` is more common
instead: `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`.)

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker        # or log out and back in
docker compose version   # confirm: should print a version, e.g. v2.2x or newer
```

## 4. Get the code and configure it

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <this repo's URL>
cd self-healing-agent
cp .env.example .env
nano .env
```

In `.env`, fill in:

- `GEMINI_API_KEY` and `GROQ_API_KEY` - your real keys.
- `ADMIN_TOKEN` - replace `change-me` with a long random value, **24+ characters**
  (production requires this - see `.env.example`). Generate one with:
  `openssl rand -hex 16`
- `DOMAIN` - your domain name, or if you don't have one, `<ip-with-dashes>.sslip.io`.
  For example, if your VM's public IP is `203.0.113.10`, use `203-0-113-10.sslip.io`.
  `.env.example` has the full explanation.

Save and exit (`Ctrl+O`, Enter, `Ctrl+X` in nano).

## 5. Start the stack

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

This builds every image (works the same on this ARM VM as it does on an amd64
laptop), starts Postgres, Prometheus, Alertmanager, both demo services, the agent, and
Caddy, and has Caddy request an HTTPS certificate for `$DOMAIN` automatically. The
first build takes a few minutes. Watch it come up:

```bash
docker compose ps
```

Wait until every service says `healthy` (Caddy has no healthcheck, so it just needs to
say `running`).

## 6. Seed the database

The demo services need their runbooks and past incidents embedded and loaded before the
agent has anything useful to retrieve:

```bash
docker compose run --rm seed
```

This runs inside Docker - you don't need Node.js installed on the VM. Re-run it any
time `db/seed/*.json` changes; it's idempotent (skips anything already embedded). Add
`--force` to re-embed everything, e.g. after changing `GEMINI_EMBED_MODEL`.

## 7. Check it's working

Open `https://<your-domain>` in a browser (the exact `DOMAIN` value from `.env`). You
should see the HealOps dashboard over a valid HTTPS certificate, with no port number
needed. Paste your `ADMIN_TOKEN` into the "Admin token" field at the top right to use
the fault-injection and approve/reject buttons.

From the VM, you can also check directly:

```bash
curl -s https://<your-domain>/health
docker compose logs -f agent      # Ctrl+C to stop watching
```

Prometheus, Alertmanager, Postgres and the demo services are **not** reachable from
outside the VM in this configuration - only Caddy (80/443) is. That's intentional; see
`docker-compose.prod.yml`.

## Updating later

```bash
cd self-healing-agent
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

This rebuilds only what changed and restarts those containers; Postgres's data and
Caddy's certificate both live in named volumes, so neither is lost.

## Viewing logs

```bash
docker compose logs -f agent          # the agent (pipeline steps, errors)
docker compose logs -f caddy          # reverse proxy / certificate issuance
docker compose logs -f                # everything, interleaved
docker compose logs --tail 200 agent  # last 200 lines, no following
```

## Stopping

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop   # stop, keep data
docker compose -f docker-compose.yml -f docker-compose.prod.yml down   # stop and remove containers (data in volumes survives)
```

To remove everything including the database and certificate, add `-v` to `down` - but
that's permanent: Postgres's data and the HTTPS certificate are both gone and will be
recreated from scratch on the next `up`.
