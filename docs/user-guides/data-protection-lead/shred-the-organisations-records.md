# How to destroy the organisation's stored files when it leaves Harbour

When your organisation stops using Harbour, make every stored document, export and data request
bundle unreadable for good, and keep a signed certificate that says so. One person asks and a
different person approves.

**Who can do this**: the owner and the quality lead (anyone who manages records retention across
the whole organisation). Each step asks you to confirm it is you (step-up).

**Register row**: PLAT-012.

## Before you start

- **A shred cannot be undone.** Every stored document, export and data request bundle stops
  opening at once. The organisation's encryption keys are destroyed for good 30 days later, and
  after that nobody can get the files back: not Harbour, and not Harbour's cloud provider.
- Care records in Harbour are not removed by this. They are deleted later, on the retention schedule.
  Database backups keep deleted records until the date the certificate gives.
- The owner downloads the organisation's full export first (**Data export** in the menu). The
  shred destroys exports too, so it needs a full export downloaded in the last 30 days.
- Release every legal hold first. While one is in force you cannot ask for a shred.

## Ask for the stored files to be destroyed

1. Go to **Records retention** in the menu. Under **Destroy the organisation's stored files**,
   choose **Go to destroying stored files**.
2. Read **What a shred does**. If **Legal holds stop a shred** is shown, release those holds on
   **Records retention** first.
3. Under **Ask for a shred**, choose the **Full export this shred follows**.
4. Under **Why the records are to be shredded**, give the reason, for example the date the contract
   ended. Do not name anyone: the reason stays on the certificate for good.
5. Tick **I understand this cannot be undone**, then choose **Ask for the shred**.
6. The page says "Shred asked for" and shows the request **Waiting for approval**, with the date it
   lapses. Tell the person who will approve it.

## Approve or refuse a shred (the second person)

1. Go to **Records retention**, then **Go to destroying stored files**. Under **Shred requests**, open the request.
2. To approve: read the warning under **Approve the shred** again. Type `shred`, tick **I understand this cannot be undone**, and choose **Approve the shred**. The request
   shows **Shredding**, then **Shredded** with its certificate.
3. To refuse: under **Refuse the shred**, give the reason (do not name anyone) and choose
   **Refuse the shred**. The request shows **Refused**. A refusal is final: ask again if needed.

You cannot approve or refuse your own request. A request lapses after 7 days: it then shows
**Lapsed**, and can only be withdrawn.

## Cancel or withdraw a request

- The person who asked can choose **Cancel this request** while it waits.
- Anyone who manages retention can choose **Withdraw this request** once it has lapsed.

## The destruction certificate

1. Open the request and choose **Open the destruction certificate**, or open it from
   **Destruction certificates** on **Records retention**.
2. **Signature check** says **Signature checked** when the certificate has not been changed since
   Harbour signed it. If it says **Signature does not match**, do not rely on it and tell Thapsus
   Cargo Ltd.
3. Choose **Download the certificate as a PDF** to keep a copy. The PDF is made when you download it, with the
   signature check at that moment, the signing key, the signature and the exact signed text.
4. Under **Details for checking the signature**, **View the signature check** shows what Harbour signed, for someone who wants to check
   it with Harbour's published certificate key.

## Good to know

- Certificates name people by a member reference, never by name, because they are kept for good.
  The certificate page shows the names beside the references.
- Until the keys are destroyed (30 days), Thapsus Cargo Ltd can restore them only through its
  break-glass procedure, if a shred was a mistake. Tell Thapsus Cargo Ltd at once.
- The rules: [platform specification, crypto-shredding screens](../../specs/platform.md#crypto-shredding-screens-and-certificates-plat-012-part-2)
  and [ADR-0109](../../decisions/0109-per-organisation-crypto-shredding.md).
