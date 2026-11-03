# The original My Helper page, with one addition

`my-helper-with-export.html` is your `index (24).html` with a single change: an **Export my data (for the hosted version)** button (in the side note, and in the Memory drawer on a phone). It saves `my-helper-export.json` from what this browser holds under `myHelperState`. It changes nothing in the page, writes nothing back and sends nothing anywhere. `original-sha.txt` is the checksum of the file as attached, so you can see which version this was made from.

**Important: browser storage belongs to the address the page is opened from.** To export your real data, open the patched page from the *same place you always opened the original* (same folder or same address) and click the button. If you open it from somewhere else, you will see an empty My Helper. If you cannot do that, open the original page, press F12, choose Console, run `copy(localStorage.getItem('myHelperState'))`, and paste the result into the import box in the hosted app (it accepts that raw text too).

Then sign in to the hosted site, open **Settings → Import from the old My Helper**, choose the file, read the preview, and confirm. Importing the same file again is safe: nothing is duplicated.
