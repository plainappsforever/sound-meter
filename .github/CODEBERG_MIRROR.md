# Codeberg mirror (note for the maintainer)

Codeberg (codeberg.org, a non-profit Forgejo host for free software) is a second home for the source, independent of
GitHub/Microsoft. Facts checked 2026-10-16 (docs.codeberg.org):

- Codeberg hosts free/libre projects; a GPL-3.0 repo fits its mission.
- **Pull mirrors** (Codeberg fetching from GitHub by itself) are not offered for new repositories ("problematic for
  Codeberg": traffic and disk). The FAQ suggests pushing to several remotes yourself.
- Codeberg's hosted CI (Woodpecker) needs a manual access request; Forgejo Actions there is "open alpha". We do not
  need either: GitHub Actions builds the releases.

## Option A (automatic, recommended): GitHub pushes to Codeberg

`.github/workflows/mirror-codeberg.yml` is already in this repo and stays off until configured:

1. Codeberg: sign up, create the organisation (same name as on GitHub if free), create an **empty** repository with
   the same name (no README, no licence - the mirror brings them).
2. Codeberg > Settings > Applications > "Generate new token": name `github-mirror`, permission *repository: read and
   write*. Copy the token.
3. GitHub repo > Settings > Secrets and variables > Actions:
   - Secrets > New: `CODEBERG_TOKEN` = the token
   - Variables > New: `CODEBERG_REPO` = `<org>/<repo>` and `CODEBERG_USER` = your Codeberg user name
4. Push anything (or run the workflow by hand: Actions > mirror-codeberg > Run workflow). main and all tags appear.

## Option B (manual): a second remote on the Mac

```sh
git remote add codeberg https://codeberg.org/<org>/<repo>.git
git push codeberg main --tags
```

## Releases on Codeberg

The mirror copies code and tags, not GitHub Release files. IzzyOnDroid and Obtainium both read GitHub Releases, so
nothing more is needed. If Codeberg should become the primary home later, Forgejo can push-mirror back to GitHub
(repository Settings > Mirror settings > Push mirror, with a GitHub token) - then turn the GitHub workflow off.
