// Mock data for the Driver Recruitment & Compliance Management System

export type DriverStatus = 'active' | 'pending' | 'inactive' | 'suspended';
export type ApplicationStatus = 'submitted' | 'in_review' | 'approved' | 'rejected' | 'on_hold';
export type DocumentStatus = 'valid' | 'expiring_soon' | 'expired' | 'pending_review' | 'rejected';
export type WorkflowStage = 
  | 'application_submitted'
  | 'document_verification' 
  | 'work_permit_application'
  | 'visa_application' 
  | 'visa_approved'
  | 'embassy_appointment'
  | 'arrival_registration'
  | 'residence_permit'
  | 'medical_examination'
  | 'interview'
  | 'contract_signing'
  | 'training'
  | 'deployment'
  | 'completed';

export interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  nationality: string;
  status: DriverStatus;
  dateOfBirth: string;
  licenseNumber: string;
  yearsExperience: number;
  currentStage: WorkflowStage;
  agencyId?: string;
  agencyName?: string;
  joinedDate: string;
  photo: string;
  address: string;
  city: string;
  country: string;
}

export interface Application {
  id: string;
  driverId: string;
  driverName: string;
  position: string;
  status: ApplicationStatus;
  submittedDate: string;
  reviewedBy?: string;
  reviewedDate?: string;
  notes: string;
  nationality: string;
}

export interface Document {
  id: string;
  driverId: string;
  driverName: string;
  type: string;
  fileName: string;
  uploadedDate: string;
  expiryDate?: string;
  status: DocumentStatus;
  verifiedBy?: string;
  verifiedDate?: string;
  fileSize: string;
}

export interface Agency {
  id: string;
  name: string;
  country: string;
  contactPerson: string;
  email: string;
  phone: string;
  activeDrivers: number;
  totalDrivers: number;
  status: 'active' | 'inactive';
  joinedDate: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'driver_applicant' | 'recruitment_agency' | 'internal_recruiter' | 'hr_manager' | 'compliance_officer' | 'finance' | 'system_admin';
  status: 'active' | 'inactive';
  lastLogin: string;
  avatar: string;
}

export interface Notification {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
}

// Mock Drivers
export const mockDrivers: Driver[] = [
  {
    id: 'D001',
    firstName: 'Jan',
    lastName: 'Kowalski',
    email: 'jan.kowalski@email.com',
    phone: '+48 123 456 789',
    nationality: 'Poland',
    status: 'active',
    dateOfBirth: '1985-03-15',
    licenseNumber: 'PL-12345-CE',
    yearsExperience: 8,
    currentStage: 'completed',
    agencyId: 'A001',
    agencyName: 'Euro Transport Recruitment',
    joinedDate: '2024-01-15',
    photo: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Jan',
    address: 'ul. Marszałkowska 123',
    city: 'Warsaw',
    country: 'Poland',
  },
  {
    id: 'D002',
    firstName: 'Ivan',
    lastName: 'Petrov',
    email: 'ivan.petrov@email.com',
    phone: '+380 98 765 4321',
    nationality: 'Ukraine',
    status: 'pending',
    dateOfBirth: '1990-07-22',
    licenseNumber: 'UA-67890-CE',
    yearsExperience: 5,
    currentStage: 'visa_application',
    agencyId: 'A002',
    agencyName: 'Global Driver Solutions',
    joinedDate: '2025-11-20',
    photo: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Ivan',
    address: 'вул. Хрещатик 45',
    city: 'Kyiv',
    country: 'Ukraine',
  },
  {
    id: 'D003',
    firstName: 'Gheorghe',
    lastName: 'Popescu',
    email: 'gheorghe.popescu@email.com',
    phone: '+40 712 345 678',
    nationality: 'Romania',
    status: 'active',
    dateOfBirth: '1988-11-03',
    licenseNumber: 'RO-54321-CE',
    yearsExperience: 10,
    currentStage: 'completed',
    joinedDate: '2023-06-10',
    photo: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Gheorghe',
    address: 'Strada Victoriei 78',
    city: 'Bucharest',
    country: 'Romania',
  },
  {
    id: 'D004',
    firstName: 'Andrei',
    lastName: 'Ivanov',
    email: 'andrei.ivanov@email.com',
    phone: '+373 79 123 456',
    nationality: 'Moldova',
    status: 'pending',
    dateOfBirth: '1992-05-18',
    licenseNumber: 'MD-98765-CE',
    yearsExperience: 4,
    currentStage: 'document_verification',
    agencyId: 'A001',
    agencyName: 'Euro Transport Recruitment',
    joinedDate: '2026-02-01',
    photo: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Andrei',
    address: 'str. Stefan cel Mare 12',
    city: 'Chisinau',
    country: 'Moldova',
  },
  {
    id: 'D005',
    firstName: 'Mykola',
    lastName: 'Shevchenko',
    email: 'mykola.shevchenko@email.com',
    phone: '+380 95 876 5432',
    nationality: 'Ukraine',
    status: 'pending',
    dateOfBirth: '1987-09-25',
    licenseNumber: 'UA-11223-CE',
    yearsExperience: 7,
    currentStage: 'work_permit_application',
    agencyId: 'A002',
    agencyName: 'Global Driver Solutions',
    joinedDate: '2025-12-15',
    photo: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Mykola',
    address: 'просп. Незалежності 89',
    city: 'Lviv',
    country: 'Ukraine',
  },
];

// Mock Applications
export const mockApplications: Application[] = [
  {
    id: 'APP001',
    driverId: 'D002',
    driverName: 'Ivan Petrov',
    position: 'International Truck Driver - CE Category',
    status: 'in_review',
    submittedDate: '2025-11-20',
    notes: 'Experienced driver with good references',
    nationality: 'Ukraine',
  },
  {
    id: 'APP002',
    driverId: 'D004',
    driverName: 'Andrei Ivanov',
    position: 'Long-haul Truck Driver',
    status: 'approved',
    submittedDate: '2026-02-01',
    reviewedBy: 'Sarah Johnson',
    reviewedDate: '2026-02-03',
    notes: 'All documents verified, proceeding to next stage',
    nationality: 'Moldova',
  },
  {
    id: 'APP003',
    driverId: 'D005',
    driverName: 'Mykola Shevchenko',
    position: 'International Truck Driver',
    status: 'on_hold',
    submittedDate: '2025-12-15',
    notes: 'Waiting for additional documentation',
    nationality: 'Ukraine',
  },
];

// Mock Documents
export const mockDocuments: Document[] = [
  {
    id: 'DOC001',
    driverId: 'D001',
    driverName: 'Jan Kowalski',
    type: 'Passport',
    fileName: 'passport_kowalski.pdf',
    uploadedDate: '2024-01-10',
    expiryDate: '2029-03-15',
    status: 'valid',
    verifiedBy: 'Maria Schmidt',
    verifiedDate: '2024-01-12',
    fileSize: '2.4 MB',
  },
  {
    id: 'DOC002',
    driverId: 'D001',
    driverName: 'Jan Kowalski',
    type: 'Driving License',
    fileName: 'license_kowalski.pdf',
    uploadedDate: '2024-01-10',
    expiryDate: '2026-05-20',
    status: 'expiring_soon',
    verifiedBy: 'Maria Schmidt',
    verifiedDate: '2024-01-12',
    fileSize: '1.8 MB',
  },
  {
    id: 'DOC003',
    driverId: 'D002',
    driverName: 'Ivan Petrov',
    type: 'Passport',
    fileName: 'passport_petrov.pdf',
    uploadedDate: '2025-11-20',
    expiryDate: '2030-07-22',
    status: 'pending_review',
    fileSize: '2.1 MB',
  },
  {
    id: 'DOC004',
    driverId: 'D003',
    driverName: 'Gheorghe Popescu',
    type: 'Medical Certificate',
    fileName: 'medical_popescu.pdf',
    uploadedDate: '2023-06-05',
    expiryDate: '2026-04-10',
    status: 'expiring_soon',
    verifiedBy: 'Dr. Weber',
    verifiedDate: '2023-06-08',
    fileSize: '1.2 MB',
  },
  {
    id: 'DOC005',
    driverId: 'D004',
    driverName: 'Andrei Ivanov',
    type: 'Driving License',
    fileName: 'license_ivanov.pdf',
    uploadedDate: '2026-02-01',
    expiryDate: '2028-11-15',
    status: 'valid',
    verifiedBy: 'Maria Schmidt',
    verifiedDate: '2026-02-02',
    fileSize: '1.9 MB',
  },
];

// Mock Agencies
export const mockAgencies: Agency[] = [
  {
    id: 'A001',
    name: 'Euro Transport Recruitment',
    country: 'Germany',
    contactPerson: 'Hans Mueller',
    email: 'hans@eurotransport.de',
    phone: '+49 30 1234567',
    activeDrivers: 45,
    totalDrivers: 68,
    status: 'active',
    joinedDate: '2022-03-15',
  },
  {
    id: 'A002',
    name: 'Global Driver Solutions',
    country: 'Netherlands',
    contactPerson: 'Pieter van der Berg',
    email: 'pieter@globaldriver.nl',
    phone: '+31 20 9876543',
    activeDrivers: 32,
    totalDrivers: 52,
    status: 'active',
    joinedDate: '2021-08-22',
  },
  {
    id: 'A003',
    name: 'Baltic Logistics Partners',
    country: 'Lithuania',
    contactPerson: 'Jonas Kazlauskas',
    email: 'jonas@balticlogistics.lt',
    phone: '+370 5 2345678',
    activeDrivers: 28,
    totalDrivers: 41,
    status: 'active',
    joinedDate: '2023-01-10',
  },
];

// Mock Users
export const mockUsers: User[] = [
  {
    id: 'U001',
    name: 'Sarah Johnson',
    email: 'sarah.johnson@company.com',
    role: 'hr_manager',
    status: 'active',
    lastLogin: '2026-03-12 09:30',
    avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah',
  },
  {
    id: 'U002',
    name: 'Maria Schmidt',
    email: 'maria.schmidt@company.com',
    role: 'compliance_officer',
    status: 'active',
    lastLogin: '2026-03-12 08:15',
    avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Maria',
  },
  {
    id: 'U003',
    name: 'Thomas Anderson',
    email: 'thomas.anderson@company.com',
    role: 'internal_recruiter',
    status: 'active',
    lastLogin: '2026-03-11 16:45',
    avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Thomas',
  },
  {
    id: 'U004',
    name: 'Admin User',
    email: 'admin@company.com',
    role: 'system_admin',
    status: 'active',
    lastLogin: '2026-03-12 07:00',
    avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Admin',
  },
];

// Mock Notifications
export const mockNotifications: Notification[] = [
  {
    id: 'N001',
    type: 'warning',
    title: 'Document Expiring Soon',
    message: "Jan Kowalski's driving license expires in 30 days",
    timestamp: '2026-03-12 09:00',
    read: false,
  },
  {
    id: 'N002',
    type: 'info',
    title: 'New Application',
    message: 'New driver application from Andrei Ivanov',
    timestamp: '2026-03-12 08:30',
    read: false,
  },
  {
    id: 'N003',
    type: 'success',
    title: 'Visa Approved',
    message: 'Work visa approved for Ivan Petrov',
    timestamp: '2026-03-11 15:20',
    read: true,
  },
  {
    id: 'N004',
    type: 'warning',
    title: 'Medical Certificate Expiring',
    message: "Gheorghe Popescu's medical certificate expires in 28 days",
    timestamp: '2026-03-11 14:00',
    read: true,
  },
];

// Dashboard Statistics
export const dashboardStats = {
  totalDrivers: 156,
  activeDrivers: 132,
  pendingApplications: 24,
  expiringDocuments: 18,
  visasPending: 8,
  completedThisMonth: 12,
  avgProcessingTime: 45, // days
  approvalRate: 87, // percentage
};

// Workflow stages configuration
export const workflowStages = [
  { id: 'application_submitted', name: 'Application Submitted', order: 1 },
  { id: 'document_verification', name: 'Document Verification', order: 2 },
  { id: 'work_permit_application', name: 'Work Permit Application', order: 3 },
  { id: 'visa_application', name: 'Visa Application', order: 4 },
  { id: 'visa_approved', name: 'Visa Approved', order: 5 },
  { id: 'embassy_appointment', name: 'Embassy Appointment', order: 6 },
  { id: 'arrival_registration', name: 'Arrival Registration', order: 7 },
  { id: 'residence_permit', name: 'Residence Permit', order: 8 },
  { id: 'medical_examination', name: 'Medical Examination', order: 9 },
  { id: 'interview', name: 'Interview', order: 10 },
  { id: 'contract_signing', name: 'Contract Signing', order: 11 },
  { id: 'training', name: 'Training', order: 12 },
  { id: 'deployment', name: 'Deployment', order: 13 },
  { id: 'completed', name: 'Onboarding Completed', order: 14 },
];