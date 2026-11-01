Redesign the existing Application Form based on the uploaded PDF questionnaire.

The new form must exactly match the structure, fields, and content of the PDF document, but transformed into a modern multi-step form experience.

The form must NOT be a single long page.

Instead, it must be divided into sequential screens (step-by-step wizard).

------------------------------------------------

1. FORM STRUCTURE (MULTI-STEP UX)

Each section in the PDF must become a separate screen.

Navigation logic:

Next button → go to next section
Back button → go to previous section
Progress bar at top showing completion %

------------------------------------------------

2. SCREENS STRUCTURE

Screen 1:
BASIC INFORMATION

Fields:

Full Name
Date of Birth
Nationality
Country of Residence
Current Country of Residence
Permanent Address
Phone
Email
Earliest Start Date
How did you hear about us?

(These fields are taken from the PDF Basic Information section) :contentReference[oaicite:1]{index=1}

------------------------------------------------

Screen 2:
TRAVEL & RESIDENCE DOCUMENTS

Fields:

Passport Number
Passport Valid Until
Do you have EU Visa (Yes/No)
Visa Type
Visa Valid Until
Do you have Work Permit (Yes/No)
Do you have Residence Card (Yes/No)
Issuing Country

------------------------------------------------

Screen 3:
LICENCE & CERTIFICATIONS

Fields:

Driving License Number
Issuing Country
License Valid Until
License Categories (A, B, C, D, E with dates)

Tachograph Card (Yes/No)
Qualification Card Code 95 (Yes/No)
ADR Certificate (Yes/No)
ADR Classes
Validity dates

------------------------------------------------

Screen 4:
INTERNATIONAL EXPERIENCE

Fields:

Have you worked in EU (Yes/No)
Years of EU Experience
Total Experience
Countries worked in

------------------------------------------------

Screen 5:
WORK EXPERIENCE PROFILE

Fields:

Kilometers driven (range selection)
Transport types (multi-select)

International
Domestic
Bilateral
Cabotage

------------------------------------------------

Screen 6:
OPERATIONAL SKILLS

Checkboxes:

Pallet exchange
Loading/unloading
CMR documentation
Load securing
Digital tachograph usage

------------------------------------------------

Screen 7:
TECHNICAL EXPERIENCE

Fields:

Truck brands (multi-select)
Gearbox type (manual / automatic / both)
Trailer types (multi-select)

------------------------------------------------

Screen 8:
SAFETY

Fields:

Accidents (Yes/No)
Violations (Yes/No)
Fines (Yes/No)
Eco-driving (Yes/No)

------------------------------------------------

Screen 9:
LANGUAGE SKILLS

Fields:

English (basic/intermediate/advanced)
German (basic/intermediate/advanced)
Russian (basic/intermediate/advanced)
Other languages

------------------------------------------------

Screen 10:
FLEXIBILITY

Fields:

Willingness for double crew (Yes/No)
Max working weeks
Preferred countries
Undesired countries
Night work
Weekend work

------------------------------------------------

3. UX DESIGN REQUIREMENTS

Each screen must:

Be clean and minimal
Have clear section title
Use step indicator at top
Use Next / Back buttons
Save progress automatically

------------------------------------------------

4. PROGRESS INDICATOR

Add a progress bar:

Step 1 of 10
Step 2 of 10
...

------------------------------------------------

5. VALIDATION

Each step must validate inputs before moving to next.

------------------------------------------------

6. FINAL SCREEN

After last step:

Show Review Screen

Display all entered data grouped by sections.

Button:

Submit Application

------------------------------------------------

7. SUBMISSION RESULT

After submission:

Show success screen:

Application Submitted Successfully

------------------------------------------------

8. DESIGN STYLE

Use modern SaaS UI style similar to:

Stripe onboarding
Typeform multi-step forms
Notion-style forms

------------------------------------------------

The final result must transform the PDF into a modern, step-by-step, user-friendly onboarding experience while preserving ALL original data fields.