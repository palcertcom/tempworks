Redesign the filtering system across the entire platform to support dynamic, column-based filtering similar to advanced SaaS systems like Airtable, Notion, and HubSpot.

------------------------------------------------

1. GLOBAL FILTER SYSTEM

Replace all existing "More Filters" buttons with a unified dynamic filter dropdown.

This new filter system must be implemented on ALL pages that contain tables, including:

Employees
Applicants
Applications
Documents
Agencies
Workflow (drivers/employees in stage)
Logs
Reports

------------------------------------------------

2. FILTER DROPDOWN BEHAVIOR

When user clicks "Filters" or "More Filters":

Open a dropdown panel containing ALL columns of the table.

Example (Employees table):

Employee Name
Email
Phone
Nationality
ID / License
Experience
Agency
Status
Job Type
Created Date

------------------------------------------------

3. FILTER BUILDER UI

Each filter should be created as a rule:

[Column] [Operator] [Value]

Example:

Nationality = Poland
Experience > 5 years
Status = Active
Agency = Global Driver Solutions

------------------------------------------------

4. OPERATORS

Operators should adapt based on data type:

TEXT:
Contains
Equals
Starts with
Ends with

NUMBER:
=
>
<
>=
<=
Between

DATE:
Before
After
Between

ENUM / SELECT:
Equals
Not Equals
In List

BOOLEAN:
Yes / No

------------------------------------------------

5. MULTIPLE FILTERS

Allow adding multiple filters:

+ Add Filter

Support AND / OR logic between filters.

Example:

Nationality = Poland AND Experience > 3 years

------------------------------------------------

6. FILTER TAGS UI

After applying filters:

Display them as removable tags above the table.

Example:

[Nationality: Poland] [Experience > 5] [Status: Active] ✕ Remove

------------------------------------------------

7. SAVED FILTERS (IMPORTANT)

Allow users to save filter configurations:

Save Filter Preset

Example:

"Senior Drivers EU"
"Pending Applications"
"Expired Documents"

------------------------------------------------

8. SEARCH + FILTER COMBINATION

Search input should work together with filters.

Example:

Search: "Ivan"
Filters: Status = Active

------------------------------------------------

9. APPLY TO ALL TABLES

This filtering system must be reusable across all modules:

Employees
Applicants
Applications
Workflow tables
Documents
Agencies
Logs

------------------------------------------------

10. UX DESIGN

Dropdown should be:

Scrollable
Grouped by column type
Searchable (search column name)

------------------------------------------------

11. DEFAULT FILTERS

Allow system to define default filters per page.

------------------------------------------------

12. PERFORMANCE

Filters should be optimized for backend queries (API filtering).

------------------------------------------------

13. EXPORT WITH FILTERS

When user clicks Export:

Export only filtered results.

------------------------------------------------

14. RESET OPTION

Add:

Clear All Filters button

------------------------------------------------

The final result must provide a powerful, flexible filtering system that allows users to filter by ANY column dynamically across all tables in the platform.