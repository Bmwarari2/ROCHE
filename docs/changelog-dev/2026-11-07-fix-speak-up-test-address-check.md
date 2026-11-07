# Speak-up rate-limit test no longer fails on random days

- `apps/api/test/speak-up.test.ts` checked that the stored network buckets hold no address by refusing
  any `2001` or `db8` in them. The buckets are HMAC digests in hex that include the UK date, so on some
  days a digest contained `db8` by chance and the test failed (seen by the slice 89 builder on 07/11).
- The check now looks for the address form `2001:db8`, which a hex digest cannot contain. The other
  assertion, that a bucket is `net:` followed by 64 hex characters, is unchanged.
- Test only; no behaviour change.
