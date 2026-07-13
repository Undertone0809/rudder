CREATE TABLE "organization_issue_prefix_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_issue_prefix_aliases" ADD CONSTRAINT "organization_issue_prefix_aliases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_issue_prefix_aliases_prefix_idx" ON "organization_issue_prefix_aliases" USING btree ("prefix");
--> statement-breakpoint
SELECT pg_advisory_xact_lock(hashtext('rudder:organization-issue-prefix'));
--> statement-breakpoint
LOCK TABLE "organizations" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT lower(route_key)
		FROM (
			SELECT "id" AS org_id, "url_key" AS route_key FROM "organizations"
			UNION ALL
			SELECT "id" AS org_id, "issue_prefix" AS route_key FROM "organizations"
		) existing_route_keys
		GROUP BY lower(route_key)
		HAVING count(DISTINCT org_id) > 1
	) THEN
		RAISE EXCEPTION 'Existing organization route identities conflict case-insensitively. Resolve the conflicting URL and Issue Keys before applying migration 0100.';
	END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "enforce_organization_route_key_namespace"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtext('rudder:organization-issue-prefix'));
	IF EXISTS (
		SELECT 1
		FROM "organizations" other
		WHERE other."id" <> NEW."id"
			AND (
				lower(other."url_key") IN (lower(NEW."url_key"), lower(NEW."issue_prefix"))
				OR lower(other."issue_prefix") IN (lower(NEW."url_key"), lower(NEW."issue_prefix"))
			)
	) OR EXISTS (
		SELECT 1
		FROM "organization_issue_prefix_aliases" alias
		WHERE alias."org_id" <> NEW."id"
			AND lower(alias."prefix") IN (lower(NEW."url_key"), lower(NEW."issue_prefix"))
	) THEN
		RAISE EXCEPTION 'Organization URL key and Issue Key routes must be unique across organizations.';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "enforce_organization_alias_route_key_namespace"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtext('rudder:organization-issue-prefix'));
	IF EXISTS (
		SELECT 1
		FROM "organizations" organization
		WHERE organization."id" <> NEW."org_id"
			AND (
				lower(organization."url_key") = lower(NEW."prefix")
				OR lower(organization."issue_prefix") = lower(NEW."prefix")
			)
	) OR EXISTS (
		SELECT 1
		FROM "organization_issue_prefix_aliases" alias
		WHERE alias."org_id" <> NEW."org_id"
			AND alias."id" <> NEW."id"
			AND lower(alias."prefix") = lower(NEW."prefix")
	) THEN
		RAISE EXCEPTION 'Historical Issue Key routes must be unique across organizations.';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "organizations_route_key_namespace_trigger"
BEFORE INSERT OR UPDATE OF "url_key", "issue_prefix" ON "organizations"
FOR EACH ROW EXECUTE FUNCTION "enforce_organization_route_key_namespace"();
--> statement-breakpoint
CREATE TRIGGER "organization_alias_route_key_namespace_trigger"
BEFORE INSERT OR UPDATE OF "org_id", "prefix" ON "organization_issue_prefix_aliases"
FOR EACH ROW EXECUTE FUNCTION "enforce_organization_alias_route_key_namespace"();
