# How to scan a medicine pack on the phone

> Arrives with the phone release from `feat/mobile-meds-cd-offline` (slices 69 and 70); not on main yet.

Scanning the pack checks it is the medicine on the MAR and has not expired, before you give it.

**Who can do this**: anyone who gives medicines on the phone: care workers, senior carers, nurses
and managers.

**Register rows**: MOB-007, MEDS-002.

## Steps

1. While recording a dose as **Given**, under **Before you give it**, choose **Scan the pack**.
2. If the phone asks, choose **Allow the camera**. The camera reads the barcode on the phone; no
   picture is kept or sent.
3. Point the camera at the pack's barcode. Both square (DataMatrix) and striped barcodes work.
4. Read the result:

| You see | Do this |
| --- | --- |
| "Pack checked: it is this medicine." | Carry on. |
| "Stop: this pack is a different medicine. Do not give it." | Do not give it. Find the right pack, or tell the nurse in charge. |
| "Stop: this pack expired on …" | Do not give it. Find another pack, or tell the nurse in charge. |
| "This barcode is not in the medicines data on this phone." | Check the pack against the medicine by hand, then choose why it could not be matched. |
| "That is not a medicine pack barcode Thapsus Care can read." | Choose **Scan another pack**, or choose why it cannot be scanned. |

5. If the pack cannot be scanned and matched, choose why under **If the pack cannot be scanned
   and matched, say why:**: **The pack has no barcode**, **The barcode will not scan**, **The pack
   is not in the medicines data**, **The person's own supply** or **Other**. For **Other**, fill in
   **Why the pack could not be scanned**.
6. To stop scanning, choose **Cancel**.

## Important

- **A different medicine or an expired pack cannot be overridden.** No reason clears it. The
  phone will not record the dose until you scan a pack that matches (HZ-113).
- **When a scan fails**, check the pack by hand against the MAR: name, strength, form and expiry.
  If you are not sure, do not give it; ask the nurse in charge.
- The phone matches packs against the medicines data it last downloaded. The line under the scan
  button says when that was ("Medicines data for pack scans on this phone from …") and when a
  newer download last failed. If it says the data has not reached the phone, no pack will match:
  connect to the internet (HZ-113).
- Thapsus Care checks a scanned pack again when the record is sent.
- A match is a check of the pack against the record, not a clinical decision. The phone never
  decides whether a medicine is right for the person.
