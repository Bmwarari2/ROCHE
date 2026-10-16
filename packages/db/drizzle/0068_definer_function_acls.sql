-- Execute rights on definer functions, set as their owners (#95 review). A function created by
-- harbour_owner can be executed by PUBLIC until that is revoked; once its owner changes, only the
-- new owner (the grantor of the default right) can revoke it, so a REVOKE run by harbour_owner
-- after ALTER FUNCTION ... OWNER TO has no effect. Migration 0061 did exactly that, leaving
-- app.family_can_see and app.family_item_shown executable by every role. This sets them as the
-- owner, which harbour_owner may become (SET TRUE, never INHERIT). The rule from here on: set a
-- definer function's ACL before changing its owner, or as the owner (ADR-0002;
-- .claude/skills/add-migration). packages/db/test/definer-acls.test.ts keeps every definer
-- function's execute rights to the roles listed there.
SET ROLE harbour_family_reader;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.family_can_see(uuid, text, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.family_item_shown(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.family_can_see(uuid, text, text, timestamptz) TO harbour_app, harbour_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.family_item_shown(uuid) TO harbour_app, harbour_owner;
--> statement-breakpoint
RESET ROLE;
