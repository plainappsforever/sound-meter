# Security policy

## Supported versions

Only the latest release of Decibel receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private report ("Security" tab -> "Report a vulnerability")
or e-mail plainapps@tuta.com with "SECURITY Decibel" in the subject. We answer within 7 days.

## Scope

The app stores all data on the device and has no server, no account and no analytics. The Android release build has no INTERNET permission at all.
Relevant reports are therefore mostly about: data readable by other apps, data left behind after deletion,
unsafe file import (malformed files), exported files containing more than the user chose, or release builds that
are not signed with the published certificate (fingerprint in the README).
