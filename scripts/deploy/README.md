# Automatic OpenSensor application releases

Main pushes validate the workspace, build Stripe/SMTP/Fief images in GHCR, and
publish per-app receipts identifying the exact source, run and platform digest.
The operator host polls every minute and deploys each app from its own receipt;
CI stays pending until that app's running image is verified. The unused manual
DigitalOcean publish workflows are replaced by this production path.

Stripe and Fief retain their existing production configuration. SMTP warms cloud,
closes local admission, allows in-flight requests to drain, updates both origins
and their release binding, then returns traffic locally and drains cloud. Health
and manifest probes are read-only. No email events are submitted by deployment.
Interrupted SMTP handoffs resume before a newer build starts. Other operator
holds and credentials are preserved.

Install on the existing operator host:

```sh
install -Dm755 scripts/deploy/saleor-app-release-launch.sh ~/.local/lib/opensensor-hosting/saleor-app-release-launch.sh
install -Dm644 scripts/deploy/opensensor-saleor-app-release.service ~/.config/systemd/user/opensensor-saleor-app-release.service
install -Dm644 scripts/deploy/opensensor-saleor-app-release.timer ~/.config/systemd/user/opensensor-saleor-app-release.timer
systemctl --user daemon-reload
systemctl --user enable --now opensensor-saleor-app-release.timer
```

Private receipts and resume state live under
`~/.config/opensensor-hosting/saleor-app-release/<app>/`. The launcher follows main
and reuses existing operator GitHub/Kubernetes access. Failures retry on the next
timer tick; inspect `journalctl --user -u opensensor-saleor-app-release.service`.
