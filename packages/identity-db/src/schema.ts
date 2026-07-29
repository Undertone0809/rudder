import {
  boolean,
  bigint,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const identitySchema = pgSchema("rudder_identity");

export const identityUsers = identitySchema.table(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_user_normalized_email_uidx").on(table.email),
  ],
);

export const identitySessions = identitySchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("identity_session_token_uidx").on(table.token),
    index("identity_session_user_idx").on(table.userId),
  ],
);

export const identityAuthAccounts = identitySchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_account_provider_subject_uidx").on(table.providerId, table.accountId),
    index("identity_account_user_idx").on(table.userId),
  ],
);

export const identityVerifications = identitySchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("identity_verification_identifier_idx").on(table.identifier),
    index("identity_verification_expiry_idx").on(table.expiresAt),
  ],
);

export const identityDeviceCodes = identitySchema.table(
  "device_code",
  {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    userId: text("user_id").references(() => identityUsers.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
  },
  (table) => [
    uniqueIndex("identity_device_code_uidx").on(table.deviceCode),
    uniqueIndex("identity_device_user_code_uidx").on(table.userCode),
    index("identity_device_code_expiry_idx").on(table.expiresAt),
  ],
);

export const identityRateLimits = identitySchema.table(
  "rate_limit",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("identity_rate_limit_key_uidx").on(table.key)],
);

export const accountEmails = identitySchema.table(
  "account_email",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("account_email_normalized_uidx").on(table.normalizedEmail),
    index("account_email_user_idx").on(table.userId),
  ],
);

export const identityDevices = identitySchema.table(
  "identity_device",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    displayName: text("display_name").notNull(),
    publicKeyThumbprint: text("public_key_thumbprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("identity_device_installation_uidx").on(table.userId, table.installationId),
    index("identity_device_user_idx").on(table.userId),
  ],
);

export const deviceRefreshCredentials = identitySchema.table(
  "device_refresh_credential",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => identityDevices.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("device_refresh_secret_hash_uidx").on(table.secretHash),
    index("device_refresh_device_idx").on(table.deviceId),
  ],
);

export const deviceAccessCredentials = identitySchema.table(
  "device_access_credential",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => identityDevices.id, { onDelete: "cascade" }),
    secretHash: text("secret_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("device_access_secret_hash_uidx").on(table.secretHash),
    index("device_access_device_idx").on(table.deviceId),
  ],
);

export const identityAuthorizationCodes = identitySchema.table(
  "authorization_code",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    audience: text("audience").notNull(),
    jti: text("jti").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_authorization_code_hash_uidx").on(table.codeHash),
    uniqueIndex("identity_authorization_code_jti_uidx").on(table.jti),
    index("identity_authorization_code_expiry_idx").on(table.expiresAt),
  ],
);

export const identityServerExchangeCodes = identitySchema.table(
  "server_exchange_code",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => identityDevices.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    audience: text("audience").notNull(),
    jti: text("jti").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("server_exchange_code_hash_uidx").on(table.codeHash),
    uniqueIndex("server_exchange_jti_uidx").on(table.jti),
    index("server_exchange_expiry_idx").on(table.expiresAt),
  ],
);

export const securityEvents = identitySchema.table(
  "security_event",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => identityUsers.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    deviceId: text("device_id").references(() => identityDevices.id, { onDelete: "set null" }),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("security_event_user_created_idx").on(table.userId, table.createdAt),
    index("security_event_type_created_idx").on(table.eventType, table.createdAt),
  ],
);

export const identityEmailRateLimits = identitySchema.table(
  "email_rate_limit",
  {
    bucketKeyHash: text("bucket_key_hash").notNull(),
    action: text("action").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.bucketKeyHash, table.action] }),
    index("email_rate_limit_blocked_idx").on(table.blockedUntil),
  ],
);
