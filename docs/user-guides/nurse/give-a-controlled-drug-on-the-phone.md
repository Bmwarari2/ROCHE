# How to give a controlled drug on the phone

> Arrives with the phone release from `feat/mobile-meds-cd-offline` (slices 69 and 70); not on main yet.

A controlled drug given on the phone needs two signatures: the witness's PIN and yours. It works
without a connection.

**Who can do this**: nurses, senior carers and managers who may give controlled drugs, with
current medicines competence. Care workers can be the witness but cannot record a controlled drug.

**Register rows**: MOB-007, MEDS-002, MEDS-005.

## Steps

1. Before the round, while there is a connection, make sure you and your witness each have a
   medicines PIN on this phone: see
   [How to set a medicines PIN on the phone](../care-worker/set-a-medicines-pin-on-the-phone.md).
2. Record the dose as usual: see
   [How to give medicines on the phone](../care-worker/give-medicines-on-the-phone.md). Choose
   **Given**, do the identity check, scan the pack and enter the **Amount given**.
3. Under **Controlled drug: two signatures**, choose the witness ("Witness:" and their name).
4. Give the dose with the witness watching. The witness types their PIN in **Witness's PIN** and
   chooses **Witness signs now**.
5. Type your own PIN in **Your PIN**.
6. Choose **Record dose**.

### When no one is here to witness

Only where your organisation allows it, such as working alone in someone's home:

1. Choose **No one is here to witness**.
2. Fill in **Why no one could witness**.
3. Type **Your PIN** and choose **Record dose**. Choose **A witness is here** to go back.

## Important

- **The witness must be a different person from you.** The phone and Thapsus Care both refuse a
  witness who is the recorder (HZ-116).
- **The witness signs first, as they see the dose given.** That fixes the amount and the time. If
  you change the amount afterwards, the witness signs again.
- **Offline**: the dose and both signatures are kept on the phone and sent at the next
  connection. The controlled drugs register entry is written only when Thapsus Care checks both
  signatures. Until then the register balance does not show this dose (HZ-115).
- **If Thapsus Care refuses the dose** (for example, the witness is not allowed to witness here,
  or your organisation requires a witness), a copy is kept on the server and an urgent review goes
  to the nurse in charge. The register is not changed, so the next stock check will show a
  difference. The dose has already been given: tell the nurse in charge at once (HZ-115).
- If either PIN does not match, try again. After several wrong PINs the phone makes you wait.
- A controlled drug's record is corrected on the web, with a witness, never on the phone. Stock
  checks are on the web.
- If you are not allowed to give controlled drugs (a care worker, for example, can only be the
  witness), the phone stops you before you start and tells you to ask a nurse or senior. Nothing
  is recorded. (This check arrives with the fix on `feat/mobile-meds-cd-offline`; checked against
  its pull request before this guide is final.)
