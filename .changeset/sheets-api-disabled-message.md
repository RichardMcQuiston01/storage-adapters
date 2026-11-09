---
'@richardmcquiston01/storage-adapters': patch
---

Make the Google Sheets adapter's error clearer when Google answers 403 because the Sheets API is not enabled for the Google Cloud project that owns the credentials. It now says so, names the project and where to enable the API, instead of suggesting the spreadsheet was not shared. The sharing hint is kept for the other 403 (the account may not edit the spreadsheet). No change to results or codes: both are still `forbidden`.
