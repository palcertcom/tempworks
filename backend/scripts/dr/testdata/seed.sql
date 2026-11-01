-- Representative multi-tenant dataset for the DR restore test.
BEGIN;

INSERT INTO tenants (id, slug, name, "updatedAt") VALUES
 ('ten_alpha','alpha','Alpha Staffing s.r.o.', now()),
 ('ten_beta','beta','Beta Recruitment GmbH', now());

INSERT INTO roles (id, name, "updatedAt") VALUES
 ('role_admin','System Admin', now()),
 ('role_hr','HR Manager', now());

INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "updatedAt", "tenantId") VALUES
 ('ag_alpha','Alpha Staffing','SK','Jana Nováková','ops@alpha.example','+421900000001', now(),'ten_alpha'),
 ('ag_beta','Beta Recruitment','DE','Hans Müller','ops@beta.example','+491700000002', now(),'ten_beta');

INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "roleId", "agencyId", "updatedAt") VALUES
 ('usr_admin','admin@alpha.example','$2b$10$abcdefghijklmnopqrstuv','Adam','Admin','role_admin','ag_alpha', now()),
 ('usr_hr_beta','hr@beta.example','$2b$10$abcdefghijklmnopqrstuv','Beata','HR','role_hr','ag_beta', now());

INSERT INTO document_types (id, name, category, "updatedAt") VALUES
 ('dt_contract','Work Contract','CONTRACT', now()),
 ('dt_id','ID Card','IDENTITY', now()),
 ('dt_med','Medical Certificate','MEDICAL', now());

INSERT INTO employees (id, "firstName","lastName",email,phone,nationality,"dateOfBirth",
   "addressLine1",city,country,"postalCode","updatedAt","agencyId","tenantId","photoUrl") VALUES
 ('emp_1','Oleksii','Kovalenko','oleksii@alpha.example','+421901111111','UA','1990-03-12',
   'Hlavna 1','Bratislava','SK','81101', now(),'ag_alpha','ten_alpha','/uploads/employees/emp_1.png'),
 ('emp_2','Tawanda','Moyo','tawanda@alpha.example','+421902222222','ZW','1988-07-01',
   'Hlavna 2','Kosice','SK','04001', now(),'ag_alpha','ten_alpha', NULL),
 ('emp_3','Ingrid','Schmidt','ingrid@beta.example','+491703333333','DE','1995-11-23',
   'Hauptstr 3','Berlin','DE','10115', now(),'ag_beta','ten_beta', NULL);

INSERT INTO applicants (id,"firstName","lastName",email,phone,"updatedAt","tenantId") VALUES
 ('app_1','Marek','Horvath','marek@alpha.example','+421903333333', now(),'ten_alpha'),
 ('app_2','Sofia','Weber','sofia@beta.example','+491704444444', now(),'ten_beta');

INSERT INTO documents (id,name,"documentTypeId","entityType","entityId","fileUrl","mimeType","fileSize","uploadedById","updatedAt","tenantId") VALUES
 ('doc_1','Oleksii Work Contract','dt_contract','EMPLOYEE','emp_1','/uploads/documents/doc_1.pdf','application/pdf', 20480,'usr_admin', now(),'ten_alpha'),
 ('doc_2','Oleksii ID Card','dt_id','EMPLOYEE','emp_1','/uploads/documents/doc_2.pdf','application/pdf', 15360,'usr_admin', now(),'ten_alpha'),
 ('doc_3','Marek CV','dt_id','APPLICANT','app_1','/uploads/documents/doc_3.pdf','application/pdf', 10240,'usr_admin', now(),'ten_alpha'),
 ('doc_4','Ingrid Medical Cert','dt_med','EMPLOYEE','emp_3','/uploads/documents/doc_4.pdf','application/pdf', 8192,'usr_hr_beta', now(),'ten_beta'),
 ('doc_5','Attendance sick note','dt_med','ATTENDANCE','att_1','/uploads/documents/doc_5.pdf','application/pdf', 4096,'usr_admin', now(),'ten_alpha');

INSERT INTO attendance_records (id,"employeeId",date,"updatedAt","tenantId") VALUES
 ('att_1','emp_1','2026-10-01', now(),'ten_alpha'),
 ('att_2','emp_1','2026-10-02', now(),'ten_alpha'),
 ('att_3','emp_3','2026-10-01', now(),'ten_beta');

COMMIT;
