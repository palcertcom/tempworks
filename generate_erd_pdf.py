#!/usr/bin/env python3
"""Generate a light-themed ERD PDF from the Prisma schema."""

from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib import colors
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
    PageBreak, HRFlowable
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.platypus import KeepTogether

# ── Colour palette (light theme) ────────────────────────────────────────────
C_PAGE_BG   = colors.HexColor("#f8fafc")
C_HEADER_BG = colors.HexColor("#1e40af")   # deep blue — table header
C_ROW_ALT   = colors.HexColor("#eff6ff")   # very light blue alternate rows
C_ROW_NORM  = colors.HexColor("#ffffff")
C_BORDER    = colors.HexColor("#93c5fd")
C_PK        = colors.HexColor("#16a34a")   # green for PK
C_FK        = colors.HexColor("#b45309")   # amber for FK
C_TYPE      = colors.HexColor("#6b7280")   # grey for types
C_TITLE_BG  = colors.HexColor("#dbeafe")   # light blue for section titles
C_TITLE_FG  = colors.HexColor("#1e3a5f")
C_REL_BG    = colors.HexColor("#f0fdf4")   # green tint for relationship table
C_REL_HDR   = colors.HexColor("#166534")
C_ENUM_BG   = colors.HexColor("#fef9c3")
C_ENUM_HDR  = colors.HexColor("#854d0e")
C_TEXT      = colors.HexColor("#1e293b")

# ── Schema data ──────────────────────────────────────────────────────────────
ENTITIES = [
    {
        "name": "Role",
        "table": "roles",
        "fields": [
            ("id",          "String (UUID)", "PK"),
            ("name",        "String",        "UNIQUE"),
            ("description", "String?",       ""),
            ("isSystem",    "Boolean",       "default: false"),
            ("createdAt",   "DateTime",      ""),
            ("updatedAt",   "DateTime",      "auto"),
            ("deletedAt",   "DateTime?",     ""),
        ],
    },
    {
        "name": "Permission",
        "table": "permissions",
        "fields": [
            ("id",        "String (UUID)", "PK"),
            ("name",      "String",        "UNIQUE"),
            ("module",    "String",        ""),
            ("action",    "String",        ""),
            ("createdAt", "DateTime",      ""),
        ],
    },
    {
        "name": "RolePermission",
        "table": "role_permissions",
        "fields": [
            ("roleId",       "String", "PK, FK → roles.id (Cascade)"),
            ("permissionId", "String", "PK, FK → permissions.id (Cascade)"),
        ],
    },
    {
        "name": "User",
        "table": "users",
        "fields": [
            ("id",           "String (UUID)",  "PK"),
            ("email",        "String",         "UNIQUE"),
            ("passwordHash", "String",         ""),
            ("firstName",    "String",         ""),
            ("lastName",     "String",         ""),
            ("phone",        "String?",        ""),
            ("roleId",       "String",         "FK → roles.id"),
            ("status",       "UserStatus",     "default: ACTIVE"),
            ("agencyId",     "String",         "FK → agencies.id"),
            ("lastLoginAt",  "DateTime?",      ""),
            ("refreshToken", "String?",        ""),
            ("createdAt",    "DateTime",       ""),
            ("updatedAt",    "DateTime",       "auto"),
            ("deletedAt",    "DateTime?",      ""),
        ],
    },
    {
        "name": "Agency",
        "table": "agencies",
        "fields": [
            ("id",                "String (UUID)", "PK"),
            ("name",              "String",        ""),
            ("country",           "String",        ""),
            ("contactPerson",     "String",        ""),
            ("email",             "String",        ""),
            ("phone",             "String",        ""),
            ("status",            "AgencyStatus",  "default: ACTIVE"),
            ("logoUrl",           "String?",       ""),
            ("notes",             "String?",       ""),
            ("maxUsersPerAgency", "Int",           "default: 10"),
            ("createdAt",         "DateTime",      ""),
            ("updatedAt",         "DateTime",      "auto"),
            ("deletedAt",         "DateTime?",     ""),
        ],
    },
    {
        "name": "Employee",
        "table": "employees",
        "fields": [
            ("id",               "String (UUID)",  "PK"),
            ("firstName",        "String",         ""),
            ("lastName",         "String",         ""),
            ("email",            "String",         "UNIQUE"),
            ("phone",            "String",         ""),
            ("nationality",      "String",         ""),
            ("status",           "EmployeeStatus", "default: PENDING"),
            ("dateOfBirth",      "DateTime",       ""),
            ("licenseNumber",    "String?",        ""),
            ("licenseCategory",  "String?",        ""),
            ("yearsExperience",  "Int",            "default: 0"),
            ("agencyId",         "String?",        "FK → agencies.id"),
            ("photoUrl",         "String?",        ""),
            ("addressLine1",     "String",         ""),
            ("addressLine2",     "String?",        ""),
            ("city",             "String",         ""),
            ("country",          "String",         ""),
            ("postalCode",       "String",         ""),
            ("emergencyContact", "String?",        ""),
            ("emergencyPhone",   "String?",        ""),
            ("notes",            "String?",        ""),
            ("createdAt",        "DateTime",       ""),
            ("updatedAt",        "DateTime",       "auto"),
            ("deletedAt",        "DateTime?",      ""),
        ],
    },
    {
        "name": "WorkflowStage",
        "table": "workflow_stages",
        "fields": [
            ("id",                   "String (UUID)",    "PK"),
            ("name",                 "String",           "UNIQUE"),
            ("order",                "Int",              ""),
            ("description",          "String?",          ""),
            ("color",                "String",           "default: #2563EB"),
            ("category",             "WorkflowCategory", "default: INITIAL"),
            ("isActive",             "Boolean",          "default: true"),
            ("requirementsDocuments","String[]",         "default: []"),
            ("requirementsActions",  "String[]",         "default: []"),
            ("requirementsApprovals","String[]",         "default: []"),
            ("createdAt",            "DateTime",         ""),
            ("updatedAt",            "DateTime",         "auto"),
        ],
    },
    {
        "name": "EmployeeWorkflowStage",
        "table": "employee_workflow_stages",
        "fields": [
            ("id",           "String (UUID)",        "PK"),
            ("employeeId",   "String",               "FK → employees.id (Cascade)"),
            ("stageId",      "String",               "FK → workflow_stages.id"),
            ("status",       "WorkflowStageStatus",  "default: PENDING"),
            ("startedAt",    "DateTime?",            ""),
            ("completedAt",  "DateTime?",            ""),
            ("notes",        "String?",              ""),
            ("assignedToId", "String?",              "FK → users.id"),
            ("createdAt",    "DateTime",             ""),
            ("updatedAt",    "DateTime",             "auto"),
        ],
    },
    {
        "name": "JobType",
        "table": "job_types",
        "fields": [
            ("id",                "String (UUID)", "PK"),
            ("name",              "String",        "UNIQUE"),
            ("description",       "String?",       ""),
            ("requiredDocuments", "String[]",      "default: []"),
            ("isActive",          "Boolean",       "default: true"),
            ("createdAt",         "DateTime",      ""),
            ("updatedAt",         "DateTime",      "auto"),
        ],
    },
    {
        "name": "Applicant",
        "table": "applicants",
        "fields": [
            ("id",                       "String (UUID)",   "PK"),
            ("firstName",                "String",          ""),
            ("lastName",                 "String",          ""),
            ("email",                    "String",          "UNIQUE"),
            ("phone",                    "String",          ""),
            ("nationality",              "String",          ""),
            ("dateOfBirth",              "DateTime",        ""),
            ("status",                   "ApplicantStatus", "default: NEW"),
            ("jobTypeId",                "String?",         "FK → job_types.id"),
            ("residencyStatus",          "String",          ""),
            ("hasNationalInsurance",     "Boolean",         "default: false"),
            ("nationalInsuranceNumber",  "String?",         ""),
            ("hasWorkAuthorization",     "Boolean",         "default: false"),
            ("workAuthorizationType",    "String?",         ""),
            ("workAuthorizationExpiry",  "DateTime?",       ""),
            ("preferredStartDate",       "DateTime?",       ""),
            ("availability",             "String",          ""),
            ("willingToRelocate",        "Boolean",         "default: false"),
            ("preferredLocations",       "String?",         ""),
            ("salaryExpectation",        "String?",         ""),
            ("notes",                    "String?",         ""),
            ("createdAt",                "DateTime",        ""),
            ("updatedAt",                "DateTime",        "auto"),
            ("deletedAt",                "DateTime?",       ""),
        ],
    },
    {
        "name": "Application",
        "table": "applications",
        "fields": [
            ("id",            "String (UUID)",     "PK"),
            ("applicantId",   "String",            "FK → applicants.id (Cascade)"),
            ("status",        "ApplicationStatus", "default: DRAFT"),
            ("submittedAt",   "DateTime?",         ""),
            ("reviewedAt",    "DateTime?",         ""),
            ("reviewedById",  "String?",           "FK → users.id"),
            ("jobTypeId",     "String?",           "FK → job_types.id"),
            ("notes",         "String?",           ""),
            ("createdAt",     "DateTime",          ""),
            ("updatedAt",     "DateTime",          "auto"),
            ("deletedAt",     "DateTime?",         ""),
        ],
    },
    {
        "name": "DocumentType",
        "table": "document_types",
        "fields": [
            ("id",                "String (UUID)", "PK"),
            ("name",              "String",        "UNIQUE"),
            ("description",       "String?",       ""),
            ("category",          "String",        ""),
            ("required",          "Boolean",       "default: false"),
            ("trackExpiry",       "Boolean",       "default: true"),
            ("renewalPeriodDays", "Int?",          ""),
            ("isActive",          "Boolean",       "default: true"),
            ("createdAt",         "DateTime",      ""),
            ("updatedAt",         "DateTime",      "auto"),
        ],
    },
    {
        "name": "Document",
        "table": "documents",
        "fields": [
            ("id",             "String (UUID)",  "PK"),
            ("name",           "String",         ""),
            ("documentTypeId", "String",         "FK → document_types.id"),
            ("entityType",     "EntityType",     ""),
            ("entityId",       "String",         ""),
            ("fileUrl",        "String",         ""),
            ("mimeType",       "String",         ""),
            ("fileSize",       "Int",            ""),
            ("status",         "DocumentStatus", "default: PENDING"),
            ("issueDate",      "DateTime?",      ""),
            ("expiryDate",     "DateTime?",      ""),
            ("issuer",         "String?",        ""),
            ("documentNumber", "String?",        ""),
            ("notes",          "String?",        ""),
            ("uploadedById",   "String",         "FK → users.id"),
            ("verifiedById",   "String?",        "FK → users.id"),
            ("verifiedAt",     "DateTime?",      ""),
            ("createdAt",      "DateTime",       ""),
            ("updatedAt",      "DateTime",       "auto"),
            ("deletedAt",      "DateTime?",      ""),
        ],
    },
    {
        "name": "WorkPermit",
        "table": "work_permits",
        "fields": [
            ("id",               "String (UUID)",  "PK"),
            ("employeeId",       "String",         "FK → employees.id (Cascade)"),
            ("permitType",       "String",         ""),
            ("status",           "WorkPermitStatus","default: PENDING"),
            ("permitNumber",     "String?",        ""),
            ("applicationDate",  "DateTime",       ""),
            ("approvalDate",     "DateTime?",      ""),
            ("expiryDate",       "DateTime",       ""),
            ("issuingAuthority", "String?",        ""),
            ("notes",            "String?",        ""),
            ("createdAt",        "DateTime",       ""),
            ("updatedAt",        "DateTime",       "auto"),
        ],
    },
    {
        "name": "Visa",
        "table": "visas",
        "fields": [
            ("id",               "String (UUID)", "PK"),
            ("entityType",       "EntityType",    "polymorphic"),
            ("entityId",         "String",        "polymorphic"),
            ("visaType",         "String",        ""),
            ("status",           "VisaStatus",    "default: PENDING"),
            ("visaNumber",       "String?",       ""),
            ("applicationDate",  "DateTime",      ""),
            ("appointmentDate",  "DateTime?",     ""),
            ("approvalDate",     "DateTime?",     ""),
            ("expiryDate",       "DateTime?",     ""),
            ("embassy",          "String?",       ""),
            ("notes",            "String?",       ""),
            ("createdAt",        "DateTime",      ""),
            ("updatedAt",        "DateTime",      "auto"),
        ],
    },
    {
        "name": "ComplianceAlert",
        "table": "compliance_alerts",
        "fields": [
            ("id",           "String (UUID)", "PK"),
            ("entityType",   "EntityType",   "polymorphic"),
            ("entityId",     "String",       "polymorphic"),
            ("documentId",   "String?",      "FK → documents.id"),
            ("alertType",    "String",       ""),
            ("severity",     "AlertSeverity","default: MEDIUM"),
            ("message",      "String",       ""),
            ("status",       "AlertStatus",  "default: OPEN"),
            ("dueDate",      "DateTime?",    ""),
            ("resolvedAt",   "DateTime?",    ""),
            ("resolvedById", "String?",      "FK → users.id"),
            ("notes",        "String?",      ""),
            ("createdAt",    "DateTime",     ""),
            ("updatedAt",    "DateTime",     "auto"),
        ],
    },
    {
        "name": "Notification",
        "table": "notifications",
        "fields": [
            ("id",              "String (UUID)",    "PK"),
            ("userId",          "String",           "FK → users.id (Cascade)"),
            ("title",           "String",           ""),
            ("message",         "String",           ""),
            ("type",            "NotificationType", "default: INFO"),
            ("isRead",          "Boolean",          "default: false"),
            ("readAt",          "DateTime?",        ""),
            ("relatedEntity",   "String?",          ""),
            ("relatedEntityId", "String?",          ""),
            ("createdAt",       "DateTime",         ""),
            ("deletedAt",       "DateTime?",        ""),
        ],
    },
    {
        "name": "AuditLog",
        "table": "audit_logs",
        "fields": [
            ("id",        "String (UUID)", "PK"),
            ("userId",    "String?",       "FK → users.id"),
            ("userEmail", "String?",       ""),
            ("action",    "String",        ""),
            ("entity",    "String",        ""),
            ("entityId",  "String",        ""),
            ("changes",   "Json?",         ""),
            ("ipAddress", "String?",       ""),
            ("userAgent", "String?",       ""),
            ("createdAt", "DateTime",      ""),
            ("deletedAt", "DateTime?",     ""),
        ],
    },
    {
        "name": "SystemSetting",
        "table": "system_settings",
        "fields": [
            ("id",           "String (UUID)", "PK"),
            ("key",          "String",        "UNIQUE"),
            ("value",        "String",        ""),
            ("description",  "String?",       ""),
            ("category",     "String",        ""),
            ("isPublic",     "Boolean",       "default: false"),
            ("updatedAt",    "DateTime",      "auto"),
            ("updatedById",  "String?",       "FK → users.id"),
        ],
    },
    {
        "name": "NotificationRule",
        "table": "notification_rules",
        "fields": [
            ("id",                "String (UUID)", "PK"),
            ("name",              "String",        ""),
            ("trigger",           "String",        ""),
            ("entityType",        "String",        ""),
            ("daysBeforeExpiry",  "Int?",          ""),
            ("channels",          "String[]",      ""),
            ("recipientRoles",    "String[]",      ""),
            ("isActive",          "Boolean",       "default: true"),
            ("createdAt",         "DateTime",      ""),
            ("updatedAt",         "DateTime",      "auto"),
            ("deletedAt",         "DateTime?",     ""),
        ],
    },
]

RELATIONSHIPS = [
    ("Role",            "1",  "N", "RolePermission",       "has permissions via"),
    ("Permission",      "1",  "N", "RolePermission",       "assigned via"),
    ("Role",            "1",  "N", "User",                 "assigned to"),
    ("Agency",          "1",  "N", "User",                 "employs"),
    ("Agency",          "1",  "N", "Employee",             "manages"),
    ("Employee",        "1",  "N", "EmployeeWorkflowStage","progresses through"),
    ("WorkflowStage",   "1",  "N", "EmployeeWorkflowStage","defines steps for"),
    ("User",            "1",  "N", "EmployeeWorkflowStage","assigned to (AssignedStages)"),
    ("JobType",         "1",  "N", "Applicant",            "applied for"),
    ("JobType",         "1",  "N", "Application",          "linked to"),
    ("Applicant",       "1",  "N", "Application",          "submits"),
    ("User",            "1",  "N", "Application",          "reviews (ReviewedApplications)"),
    ("DocumentType",    "1",  "N", "Document",             "categorises"),
    ("User",            "1",  "N", "Document",             "uploads (UploadedDocuments)"),
    ("User",            "1",  "N", "Document",             "verifies (VerifiedDocuments)"),
    ("Employee",        "1",  "N", "WorkPermit",           "holds"),
    ("Document",        "1",  "N", "ComplianceAlert",      "triggers"),
    ("User",            "1",  "N", "ComplianceAlert",      "resolves (ResolvedAlerts)"),
    ("User",            "1",  "N", "Notification",         "receives"),
    ("User",            "1",  "N", "AuditLog",             "generates"),
    ("User",            "1",  "N", "SystemSetting",        "updates"),
]

ENUMS = [
    ("UserStatus",         ["ACTIVE", "INACTIVE", "SUSPENDED", "PENDING"]),
    ("AgencyStatus",       ["ACTIVE", "INACTIVE", "SUSPENDED"]),
    ("EmployeeStatus",     ["ACTIVE", "INACTIVE", "PENDING", "ONBOARDING", "TERMINATED", "ON_LEAVE"]),
    ("ApplicantStatus",    ["NEW", "SCREENING", "INTERVIEW", "OFFER", "ACCEPTED", "REJECTED", "WITHDRAWN", "ONBOARDING"]),
    ("ApplicationStatus",  ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "WITHDRAWN"]),
    ("DocumentStatus",     ["PENDING", "VERIFIED", "REJECTED", "EXPIRED", "EXPIRING_SOON"]),
    ("WorkflowStageStatus",["PENDING", "IN_PROGRESS", "COMPLETED", "SKIPPED", "BLOCKED"]),
    ("WorkflowCategory",   ["INITIAL", "DOCUMENTATION", "COMPLIANCE", "TRAINING", "DEPLOYMENT", "ADMINISTRATIVE"]),
    ("WorkPermitStatus",   ["PENDING", "APPLIED", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"]),
    ("VisaStatus",         ["PENDING", "APPLIED", "APPOINTMENT_SCHEDULED", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"]),
    ("AlertSeverity",      ["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    ("AlertStatus",        ["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"]),
    ("NotificationType",   ["INFO", "WARNING", "ERROR", "SUCCESS", "COMPLIANCE", "DOCUMENT_EXPIRY", "WORKFLOW", "SYSTEM"]),
    ("EntityType",         ["EMPLOYEE", "APPLICANT", "APPLICATION", "AGENCY", "USER"]),
]

# ── PDF helpers ──────────────────────────────────────────────────────────────

def make_styles():
    styles = getSampleStyleSheet()
    base = styles["Normal"]

    title = ParagraphStyle(
        "DocTitle",
        parent=base,
        fontSize=22,
        textColor=C_TITLE_FG,
        alignment=TA_CENTER,
        spaceAfter=4,
        fontName="Helvetica-Bold",
    )
    subtitle = ParagraphStyle(
        "DocSubtitle",
        parent=base,
        fontSize=11,
        textColor=C_TYPE,
        alignment=TA_CENTER,
        spaceAfter=20,
    )
    section = ParagraphStyle(
        "SectionHead",
        parent=base,
        fontSize=14,
        textColor=C_TITLE_FG,
        fontName="Helvetica-Bold",
        spaceBefore=14,
        spaceAfter=4,
    )
    cell = ParagraphStyle(
        "Cell",
        parent=base,
        fontSize=8,
        textColor=C_TEXT,
        leading=10,
    )
    pk_cell = ParagraphStyle(
        "PkCell",
        parent=base,
        fontSize=8,
        textColor=C_PK,
        fontName="Helvetica-Bold",
        leading=10,
    )
    fk_cell = ParagraphStyle(
        "FkCell",
        parent=base,
        fontSize=8,
        textColor=C_FK,
        leading=10,
    )
    type_cell = ParagraphStyle(
        "TypeCell",
        parent=base,
        fontSize=8,
        textColor=C_TYPE,
        leading=10,
    )
    note_cell = ParagraphStyle(
        "NoteCell",
        parent=base,
        fontSize=7.5,
        textColor=colors.HexColor("#374151"),
        leading=10,
    )
    return title, subtitle, section, cell, pk_cell, fk_cell, type_cell, note_cell


def entity_table(entity, cell_style, pk_style, fk_style, type_style, note_style, col_widths):
    """Build a single entity table block."""
    # Header row
    header = [
        Paragraph(f"<b>{entity['name']}</b>  <font color='#6b7280' size='7.5'>({entity['table']})</font>", pk_style),
        Paragraph("<b>Type</b>", type_style),
        Paragraph("<b>Constraints / Notes</b>", note_style),
    ]
    rows = [header]

    for col, typ, note in entity["fields"]:
        is_pk = "PK" in note
        is_fk = "FK" in note

        if is_pk:
            c_style = pk_style
        elif is_fk:
            c_style = fk_style
        else:
            c_style = cell_style

        rows.append([
            Paragraph(col, c_style),
            Paragraph(typ, type_style),
            Paragraph(note, note_style),
        ])

    t = Table(rows, colWidths=col_widths, repeatRows=1)

    style = TableStyle([
        # Header background
        ("BACKGROUND", (0, 0), (-1, 0), C_TITLE_BG),
        ("TEXTCOLOR",  (0, 0), (-1, 0), C_TITLE_FG),
        ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",   (0, 0), (-1, 0), 9),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("TOPPADDING",    (0, 0), (-1, 0), 5),
        # Alternating rows
        *[
            ("BACKGROUND", (0, i), (-1, i), C_ROW_ALT if i % 2 == 0 else C_ROW_NORM)
            for i in range(1, len(rows))
        ],
        # Grid
        ("GRID",    (0, 0), (-1, -1), 0.4, C_BORDER),
        ("BOX",     (0, 0), (-1, -1), 0.8, C_HEADER_BG),
        # Padding
        ("TOPPADDING",    (0, 1), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 3),
        ("LEFTPADDING",   (0, 0), (-1, -1), 5),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ])
    t.setStyle(style)
    return t


def relationships_table(rel_style, hdr_style, col_widths):
    header = [
        Paragraph("<b>Parent</b>", hdr_style),
        Paragraph("<b>Card.</b>", hdr_style),
        Paragraph("<b>Child</b>", hdr_style),
        Paragraph("<b>Description</b>", hdr_style),
    ]
    rows = [header]
    for parent, card_p, card_c, child, desc in RELATIONSHIPS:
        cardinality = f"{card_p} → {card_c}"
        rows.append([
            Paragraph(parent, rel_style),
            Paragraph(cardinality, rel_style),
            Paragraph(child, rel_style),
            Paragraph(desc, rel_style),
        ])

    t = Table(rows, colWidths=col_widths, repeatRows=1)
    style = TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), C_REL_HDR),
        ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
        ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",   (0, 0), (-1, 0), 9),
        *[
            ("BACKGROUND", (0, i), (-1, i), C_REL_BG if i % 2 == 1 else C_ROW_NORM)
            for i in range(1, len(rows))
        ],
        ("GRID",  (0, 0), (-1, -1), 0.4, colors.HexColor("#86efac")),
        ("BOX",   (0, 0), (-1, -1), 0.8, C_REL_HDR),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING",   (0, 0), (-1, -1), 5),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ])
    t.setStyle(style)
    return t


def enums_table(enums, cell_style, hdr_style, col_widths):
    header = [
        Paragraph("<b>Enum</b>", hdr_style),
        Paragraph("<b>Values</b>", hdr_style),
    ]
    rows = [header]
    for name, values in enums:
        rows.append([
            Paragraph(f"<b>{name}</b>", cell_style),
            Paragraph(",  ".join(values), cell_style),
        ])

    t = Table(rows, colWidths=col_widths, repeatRows=1)
    style = TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), C_ENUM_HDR),
        ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
        ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",   (0, 0), (-1, 0), 9),
        *[
            ("BACKGROUND", (0, i), (-1, i), C_ENUM_BG if i % 2 == 1 else C_ROW_NORM)
            for i in range(1, len(rows))
        ],
        ("GRID",  (0, 0), (-1, -1), 0.4, colors.HexColor("#fde68a")),
        ("BOX",   (0, 0), (-1, -1), 0.8, C_ENUM_HDR),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING",   (0, 0), (-1, -1), 5),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ])
    t.setStyle(style)
    return t


# ── Build PDF ────────────────────────────────────────────────────────────────

def build_pdf(out_path):
    page = landscape(A3)
    doc = SimpleDocTemplate(
        out_path,
        pagesize=page,
        leftMargin=1.5*cm, rightMargin=1.5*cm,
        topMargin=1.5*cm, bottomMargin=1.5*cm,
        title="ERD – Tempworks Employee Recruitment & Compliance Management System",
        author="TempWorks",
    )

    page_w = page[0] - 3*cm   # usable width
    col_w  = [page_w * 0.28, page_w * 0.18, page_w * 0.54]  # name / type / notes

    title_s, subtitle_s, section_s, cell_s, pk_s, fk_s, type_s, note_s = make_styles()

    story = []

    # ── Cover / title block
    story.append(Spacer(1, 1*cm))
    story.append(Paragraph(
        "TempWorks — Employee Recruitment &amp; Compliance Management System",
        title_s
    ))
    story.append(Paragraph("Entity Relationship Diagram  ·  Database Schema Reference", subtitle_s))
    story.append(HRFlowable(width="100%", thickness=1.5, color=C_HEADER_BG, spaceAfter=16))

    # Legend
    legend_data = [[
        Paragraph("<font color='#16a34a'><b>Green column name</b></font> = Primary Key", note_s),
        Paragraph("<font color='#b45309'><b>Amber column name</b></font> = Foreign Key", note_s),
        Paragraph("<font color='#6b7280'>Grey type text</font> = Data type", note_s),
        Paragraph("? suffix = nullable field", note_s),
    ]]
    legend_t = Table(legend_data, colWidths=[page_w/4]*4)
    legend_t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f1f5f9")),
        ("BOX",        (0, 0), (-1, -1), 0.5, C_BORDER),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
    ]))
    story.append(legend_t)
    story.append(Spacer(1, 0.5*cm))

    # ── Entity tables (3-column grid layout per page)
    story.append(Paragraph("Entities", section_s))
    story.append(HRFlowable(width="100%", thickness=0.5, color=C_BORDER, spaceAfter=8))

    # Layout 3 entities per row using a wrapper table
    entity_col_w = [(page_w - 1.2*cm) / 3] * 3
    inner_col_w  = [entity_col_w[0]*0.30, entity_col_w[0]*0.22, entity_col_w[0]*0.48]

    grid_cells = []
    row_cells  = []
    for i, entity in enumerate(ENTITIES):
        tbl = entity_table(entity, cell_s, pk_s, fk_s, type_s, note_s, inner_col_w)
        row_cells.append(tbl)
        if len(row_cells) == 3:
            grid_cells.append(row_cells)
            row_cells = []
    if row_cells:
        while len(row_cells) < 3:
            row_cells.append("")
        grid_cells.append(row_cells)

    grid = Table(grid_cells, colWidths=entity_col_w, hAlign="LEFT")
    grid.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 3),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 3),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(grid)

    # ── Relationships
    story.append(PageBreak())
    story.append(Paragraph("Relationships", section_s))
    story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#86efac"), spaceAfter=8))

    rel_hdr_s = ParagraphStyle("RelHdr", parent=cell_s, textColor=colors.white, fontName="Helvetica-Bold", fontSize=9)
    rel_col_w = [page_w*0.17, page_w*0.10, page_w*0.17, page_w*0.56]
    story.append(relationships_table(cell_s, rel_hdr_s, rel_col_w))

    # ── Enumerations
    story.append(Spacer(1, 0.7*cm))
    story.append(Paragraph("Enumerations", section_s))
    story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#fde68a"), spaceAfter=8))

    enum_hdr_s = ParagraphStyle("EnumHdr", parent=cell_s, textColor=colors.white, fontName="Helvetica-Bold", fontSize=9)
    enum_col_w = [page_w*0.22, page_w*0.78]
    story.append(enums_table(ENUMS, cell_s, enum_hdr_s, enum_col_w))

    # ── Polymorphic note
    story.append(Spacer(1, 0.7*cm))
    poly_note = ParagraphStyle("PolyNote", parent=cell_s, fontSize=8, textColor=colors.HexColor("#374151"),
                               backColor=colors.HexColor("#fef3c7"), borderPad=6)
    story.append(Paragraph(
        "<b>Note on polymorphic relations:</b>  The <b>Document</b>, <b>Visa</b>, and "
        "<b>ComplianceAlert</b> tables use <b>entityType + entityId</b> columns to reference "
        "multiple entity types (EMPLOYEE, APPLICANT, etc.) without a hard foreign key constraint.",
        poly_note
    ))

    doc.build(story)
    print(f"PDF written → {out_path}")


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(__file__), "ERD.pdf")
    build_pdf(out)
