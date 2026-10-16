# Contributing to Decibel

Thank you for helping. Bug reports and translations are the most useful contributions.

## Reporting a bug

Open an issue at https://github.com/plainappsforever/sound-meter/issues with: phone model, OS version, app version (shown on the About screen), what you
did, what you expected and what happened. Please never attach real personal data (receipts, IDs, customer lists) -
use made-up examples.

## Code changes

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Keep the app's rules: works offline, no accounts, no analytics or tracking, no ads, no new network access,
   no proprietary SDKs (no Google Play services, Firebase or ML Kit in the shared code).
3. Run `npm ci && npm run verify` before you open a pull request; add a test for behaviour worth protecting.
4. Database changes need a new migration (never edit an old one).

## Licence of contributions

The app is published under GPL-3.0-only and the maintainer also ships it through Apple's App Store, whose terms
are widely considered incompatible with the GPL for code the maintainer does not own. So that your contribution can
ship in every store, by opening a pull request you confirm that:

- you wrote the contribution (or have the right to submit it), and it is licensed under GPL-3.0-only; and
- you grant Farija Retkoceri a perpetual, worldwide, non-exclusive, royalty-free licence to distribute your
  contribution as part of the app under other licence terms as well (for example the App Store terms).

Add `Signed-off-by: Your Name <you@example.com>` to your commits (`git commit -s`) to confirm this.
(Draft wording, not legal advice; the maintainer may replace it with a formal contributor agreement.)
