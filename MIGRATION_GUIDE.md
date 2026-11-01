# Database Migration Guide

This guide explains how to apply pending database migrations for the TempWorks Employee Recruitment Compliance Management System.

## Latest Migration: Notification Preferences (2024-04-25)

The notification preferences table is required for the fleet manager notification system to function properly.

### What the Migration Does

1. Creates the `notification_preferences` table to store fleet manager notification settings
2. Adds missing fields to the `notifications` table:
   - `daysUntilDue`: Number of days until a vehicle's compliance expires
   - `kmUntilDue`: Number of kilometers until a vehicle needs service
   - `severity`: Notification severity level (LOW, MEDIUM, HIGH)

### How to Apply the Migration

Navigate to the backend directory and run the migration script:

```bash
cd backend
npm run db:migrate:notification-preferences
```

This will:
1. Create the `notification_preferences` table
2. Add missing columns to the `notifications` table
3. Create necessary indexes

### What You Need

- Node.js installed with npm
- Access to your PostgreSQL database (via DATABASE_URL environment variable)
- The `.env` file properly configured with your database connection string

### Verification

After running the migration, verify it was successful by checking that:

1. The `notification_preferences` table exists and has the correct columns
2. The `notifications` table has the new columns (`daysUntilDue`, `kmUntilDue`, `severity`)

You can verify this by running:
```bash
npm run prisma:studio
```

Then navigate to the `NotificationPreference` model and `Notification` model to inspect the tables.

### Troubleshooting

**Error: "Table does not exist"**
- Ensure you've run the migration script: `npm run db:migrate:notification-preferences`
- Check that your DATABASE_URL is set correctly in `.env`

**Error: "Database connection failed"**
- Verify your PostgreSQL service is running
- Check your DATABASE_URL in `.env` is valid
- Ensure you have network access to the database server

**Error: "Column already exists"**
- This is expected if the migration has already been applied
- The migration is idempotent, so running it again is safe

### Next Steps

After applying the migration, restart your backend server:

```bash
npm run start:dev
```

The fleet manager notification system should now work correctly.

## Other Available Migrations

You can run any of the other migrations listed in `backend/package.json` using the `db:migrate:*` scripts:

```bash
npm run db:migrate:finance
npm run db:migrate:vehicles
npm run db:migrate:two-factor
# ... etc
```

## Questions?

If you encounter issues applying migrations, check:
1. That your database is running and accessible
2. That your DATABASE_URL environment variable is set
3. That you have the necessary database permissions
4. The migration logs for specific error messages
