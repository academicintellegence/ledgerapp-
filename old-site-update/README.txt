STEP 1 - SAVE YOUR DATA FROM THE CURRENT SITE
=============================================

Your entries, accounts and receipt photos live inside the browser on the device you
use today (not on GitHub). The new cloud version can't see them directly, so first
you save them into one backup file. This update adds a "Download backup" button.

1. In your GitHub repo, replace these two files with the ones in this folder:
     index.html
     sw.js
   (Same names, same place. Commit the change.)

2. Wait a minute or two for GitHub Pages to update, then on the device that has your
   data (your iPhone, if that's where you log things):
     - fully close the app (swipe it away) and open it again, twice if needed
     - sw.js was changed so the new version is picked up instead of the old cached one

3. Open the menu (the three lines at the top right) > Settings > "Download backup".
     - On iPhone a share sheet opens: choose "Save to Files".
     - The toast at the bottom says how many entries and receipt photos were saved.
       Check that those numbers look right.

4. Keep that .json file safe. Your existing data is not deleted or changed by this.

If you use the app on more than one device, each device has its own separate data.
Make a backup on each one; you can import them one after another into the cloud
account (importing the same file twice never creates duplicates).

Then continue with the main README (ledger-cloud/README.md).
