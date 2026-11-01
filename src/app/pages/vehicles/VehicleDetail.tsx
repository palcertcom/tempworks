import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Edit, Truck, User, FileText, Wrench, Plus,
  Trash2, AlertTriangle, Search, Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { confirm } from '../../components/ui/ConfirmDialog';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { vehiclesApi, employeesApi } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { apiError } from '../../../i18n/apiError';
import { enumLabel } from '../../../i18n/enumLabel';
import { formatDate, formatCurrency, formatNumber } from '../../../i18n/formatters';
import { DateInput } from '../../components/ui/date-input';

const MAINTENANCE_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

function statusBadge(status: string) {
  const map: Record<string, string> = {
    ACTIVE: 'bg-green-100 text-green-800',
    INACTIVE: 'bg-gray-100 text-gray-700',
    IN_MAINTENANCE: 'bg-yellow-100 text-yellow-800',
    SCRAPPED: 'bg-red-100 text-red-800',
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-700'}`}>{enumLabel('maintenanceStatus', status) || status.replace('_', ' ')}</span>;
}

function mStatusBadge(status: string) {
  const map: Record<string, string> = {
    SCHEDULED: 'bg-blue-100 text-blue-800',
    IN_PROGRESS: 'bg-yellow-100 text-yellow-800',
    COMPLETED: 'bg-green-100 text-green-800',
    CANCELLED: 'bg-gray-100 text-gray-600',
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-700'}`}>{enumLabel('maintenanceStatus', status) || status.replace('_', ' ')}</span>;
}

function ExpiryCell({ date }: { date: string | null | undefined }) {
  const { t } = useTranslation('pages');
  if (!date) return <span className="text-muted-foreground text-xs">—</span>;
  const d = new Date(date);
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  const text = formatDate(d);
  if (days < 0)  return <span className="text-red-600 text-xs font-medium flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{text} ({t('vehicles.detail.expired')})</span>;
  if (days <= 30) return <span className="text-amber-600 text-xs font-medium flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{text} ({days}{t('vehicles.detail.daysSuffix')})</span>;
  return <span className="text-xs">{text}</span>;
}

export function VehicleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const canWrite = canCreate('vehicles');
  const { t } = useTranslation(['pages', 'common']);

  const [vehicle, setVehicle]             = useState<any>(null);
  const [loading, setLoading]             = useState(true);
  const [workshops, setWorkshops]         = useState<any[]>([]);
  const [maintenanceTypes, setMtnTypes]   = useState<any[]>([]);
  const [drivers, setDrivers]             = useState<any[]>([]);

  // Assign driver dialog
  const [assignDialog, setAssignDialog]     = useState(false);
  const [driverEmployeeId, setDriverEmpId]  = useState('');
  const [driverSelectedName, setDriverName] = useState('');
  const [driverStartDate, setDriverStart]   = useState(new Date().toISOString().split('T')[0]);
  const [assigningSaving, setAssignSaving]  = useState(false);

  // Driver picker search
  const [driverSearch, setDriverSearch]     = useState('');
  const [driverOptions, setDriverOptions]   = useState<any[]>([]);
  const [driverLoading, setDriverLoading]   = useState(false);
  const [pickerOpen, setPickerOpen]         = useState(false);
  const pickerRef                           = useRef<HTMLDivElement>(null);

  // Add / Edit document dialog
  const [docDialog, setDocDialog]         = useState(false);
  const [editingDoc, setEditingDoc]       = useState<any>(null);
  const [docForm, setDocForm]             = useState({ name: '', documentType: 'MOT', expiryDate: '', issuedDate: '', issuer: '', notes: '' });
  const [docFile, setDocFile]             = useState<File | null>(null);
  const [docSaving, setDocSaving]         = useState(false);

  // Add / Edit maintenance dialog
  const [mainDialog, setMainDialog]       = useState(false);
  const [editingMain, setEditingMain]     = useState<any>(null);
  const [mainForm, setMainForm]           = useState<any>({
    maintenanceTypeId: '', workshopId: '', status: 'SCHEDULED',
    scheduledDate: '', completedDate: '', description: '', workDescription: '', mileageAtService: '', cost: '', notes: '',
    driverId: '', driverNameOverride: '',
    dropOffDriverId: '', dropOffDriverNameOverride: '', dropOffDateTime: '',
    pickUpDriverId: '', pickUpDriverNameOverride: '', pickUpDateTime: '',
    approvedById: '', approvedAt: '',
  });
  const [mainSaving, setMainSaving]       = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [v, ws, mt, drvs] = await Promise.all([
        vehiclesApi.getOne(id!),
        vehiclesApi.listWorkshops(),
        vehiclesApi.listMaintenanceTypes(),
        employeesApi.list({ driversOnly: 'true', limit: 100 }).catch(() => ({ data: [] })),
      ]);
      setVehicle(v);
      setWorkshops(ws);
      setMtnTypes(mt);
      setDrivers(drvs.data ?? []);
    } catch (err) {
      toast.error(apiError(err, t('pages:vehicles.detail.toast.loadFailed')));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  // Load driver options when the assign dialog opens or search changes
  useEffect(() => {
    if (!assignDialog) return;
    let cancelled = false;
    setDriverLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await employeesApi.list({
          driversOnly: 'true',
          search: driverSearch || undefined,
          limit: 50,
        });
        if (!cancelled) setDriverOptions(res.data ?? []);
      } catch {
        // non-critical
      } finally {
        if (!cancelled) setDriverLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [assignDialog, driverSearch]);

  // Close picker on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleDelete = async () => {
    if (!(await confirm({
      title: t('pages:vehicles.detail.confirmDelete.title'),
      description: t('pages:vehicles.detail.confirmDelete.description'),
      confirmText: t('pages:vehicles.detail.confirmDelete.confirm'), tone: 'destructive',
    }))) return;
    try {
      await vehiclesApi.delete(id!);
      toast.success(t('pages:vehicles.detail.toast.deleted'));
      navigate('/dashboard/vehicles');
    } catch (err) {
      toast.error(apiError(err, t('pages:vehicles.detail.toast.deleteFailed')));
    }
  };

  const handleAssignDriver = async () => {
    if (!driverEmployeeId) { toast.error(t('pages:vehicles.detail.driver.toast.selectFirst')); return; }
    setAssignSaving(true);
    try {
      await vehiclesApi.assignDriver(id!, { employeeId: driverEmployeeId, startDate: driverStartDate });
      toast.success(t('pages:vehicles.detail.driver.toast.assigned'));
      setAssignDialog(false);
      load();
    } catch (err) {
      toast.error(apiError(err, t('pages:vehicles.detail.driver.toast.assignFailed')));
    } finally {
      setAssignSaving(false);
    }
  };

  const handleUnassign = async (assignmentId: string) => {
    if (!(await confirm({
      title: t('pages:vehicles.detail.driver.confirmEnd.title'),
      description: t('pages:vehicles.detail.driver.confirmEnd.description'),
      confirmText: t('pages:vehicles.detail.driver.confirmEnd.confirm'),
    }))) return;
    try {
      await vehiclesApi.unassignDriver(id!, assignmentId);
      toast.success(t('pages:vehicles.detail.driver.toast.unassigned'));
      load();
    } catch (err) {
      toast.error(apiError(err, t('pages:vehicles.detail.driver.toast.unassignFailed')));
    }
  };

  const openAddDoc = () => {
    setEditingDoc(null);
    setDocForm({ name: '', documentType: 'MOT', expiryDate: '', issuedDate: '', issuer: '', notes: '' });
    setDocFile(null);
    setDocDialog(true);
  };

  const openEditDoc = (doc: any) => {
    setEditingDoc(doc);
    setDocForm({
      name:         doc.name ?? '',
      documentType: doc.documentType ?? 'MOT',
      expiryDate:   doc.expiryDate ? doc.expiryDate.split('T')[0] : '',
      issuedDate:   doc.issuedDate ? doc.issuedDate.split('T')[0] : '',
      issuer:       doc.issuer ?? '',
      notes:        doc.notes ?? '',
    });
    setDocFile(null);
    setDocDialog(true);
  };

  const handleSaveDoc = async () => {
    if (!docForm.name.trim()) { toast.error(t('pages:vehicles.detail.documents.toast.nameRequired')); return; }
    setDocSaving(true);
    try {
      if (editingDoc) {
        await vehiclesApi.updateDocument(id!, editingDoc.id, {
          name:         docForm.name,
          documentType: docForm.documentType,
          expiryDate:   docForm.expiryDate || undefined,
          issuedDate:   docForm.issuedDate || undefined,
          issuer:       docForm.issuer || undefined,
          notes:        docForm.notes || undefined,
        });
        toast.success(t('pages:vehicles.detail.documents.toast.updated'));
      } else {
        await vehiclesApi.addDocument(
          id!,
          {
            name:         docForm.name,
            documentType: docForm.documentType,
            expiryDate:   docForm.expiryDate || undefined,
            issuedDate:   docForm.issuedDate || undefined,
            issuer:       docForm.issuer || undefined,
            notes:        docForm.notes || undefined,
          },
          docFile ?? undefined,
        );
        toast.success(t('pages:vehicles.detail.documents.toast.added'));
      }
      setDocDialog(false);
      load();
    } catch (err) {
      toast.error(apiError(err, editingDoc ? t('pages:vehicles.detail.documents.toast.updateFailed') : t('pages:vehicles.detail.documents.toast.addFailed')));
    } finally {
      setDocSaving(false);
    }
  };

  const handleDeleteDoc = async (docId: string) => {
    if (!(await confirm({
      title: t('pages:vehicles.detail.documents.confirmDelete.title'),
      description: t('pages:vehicles.detail.documents.confirmDelete.description'),
      confirmText: t('pages:vehicles.detail.documents.confirmDelete.confirm'), tone: 'destructive',
    }))) return;
    try {
      await vehiclesApi.deleteDocument(id!, docId);
      toast.success(t('pages:vehicles.detail.documents.toast.deleted'));
      load();
    } catch (err) {
      toast.error(apiError(err, t('pages:vehicles.detail.documents.toast.deleteFailed')));
    }
  };

  const BLANK_MAIN = {
    maintenanceTypeId: '', workshopId: '', status: 'SCHEDULED', scheduledDate: '', completedDate: '', description: '', workDescription: '', mileageAtService: '', cost: '', notes: '',
    driverId: '', driverNameOverride: '',
    dropOffDriverId: '', dropOffDriverNameOverride: '', dropOffDateTime: '',
    pickUpDriverId: '', pickUpDriverNameOverride: '', pickUpDateTime: '',
    approvedById: '', approvedAt: '',
  };

  const openAddMaintenance = () => {
    setEditingMain(null);
    setMainForm(BLANK_MAIN);
    setMainDialog(true);
  };

  const openEditMaintenance = (rec: any) => {
    setEditingMain(rec);
    setMainForm({
      maintenanceTypeId: rec.maintenanceTypeId ?? '',
      workshopId:        rec.workshopId ?? '',
      status:            rec.status ?? 'SCHEDULED',
      scheduledDate:     rec.scheduledDate ? rec.scheduledDate.split('T')[0] : '',
      completedDate:     rec.completedDate ? rec.completedDate.split('T')[0] : '',
      description:       rec.description ?? '',
      workDescription:   rec.workDescription ?? '',
      mileageAtService:  rec.mileageAtService ?? '',
      cost:              rec.cost ?? '',
      notes:             rec.notes ?? '',
      driverId:          rec.driverId ?? '',
      driverNameOverride: rec.driverNameOverride ?? '',
      dropOffDriverId:   rec.dropOffDriverId ?? '',
      dropOffDriverNameOverride: rec.dropOffDriverNameOverride ?? '',
      dropOffDateTime:   rec.dropOffDateTime ? rec.dropOffDateTime.replace('Z', '').slice(0, 16) : '',
      pickUpDriverId:    rec.pickUpDriverId ?? '',
      pickUpDriverNameOverride: rec.pickUpDriverNameOverride ?? '',
      pickUpDateTime:    rec.pickUpDateTime ? rec.pickUpDateTime.replace('Z', '').slice(0, 16) : '',
      approvedById:      rec.approvedById ?? '',
      approvedAt:        rec.approvedAt ? rec.approvedAt.split('T')[0] : '',
    });
    setMainDialog(true);
  };

  const handleSaveMaintenance = async () => {
    setMainSaving(true);
    try {
      const payload: any = {
        maintenanceTypeId: mainForm.maintenanceTypeId || undefined,
        workshopId:        mainForm.workshopId || undefined,
        status:            mainForm.status,
        scheduledDate:     mainForm.scheduledDate || undefined,
        completedDate:     mainForm.completedDate || undefined,
        description:       mainForm.description || undefined,
        workDescription:   mainForm.workDescription || undefined,
        mileageAtService:  mainForm.mileageAtService ? parseInt(mainForm.mileageAtService) : undefined,
        cost:              mainForm.cost ? parseFloat(mainForm.cost) : undefined,
        notes:             mainForm.notes || undefined,
        driverId:          mainForm.driverId || undefined,
        driverNameOverride: mainForm.driverNameOverride || undefined,
        dropOffDriverId:   mainForm.dropOffDriverId || undefined,
        dropOffDriverNameOverride: mainForm.dropOffDriverNameOverride || undefined,
        dropOffDateTime:   mainForm.dropOffDateTime || undefined,
        pickUpDriverId:    mainForm.pickUpDriverId || undefined,
        pickUpDriverNameOverride: mainForm.pickUpDriverNameOverride || undefined,
        pickUpDateTime:    mainForm.pickUpDateTime || undefined,
        approvedById:      mainForm.approvedById || undefined,
        approvedAt:        mainForm.approvedAt || undefined,
      };
      if (editingMain) {
        await vehiclesApi.updateMaintenance(editingMain.id, payload);
        toast.success(t('pages:vehicles.detail.maintenance.toast.updated'));
      } else {
        await vehiclesApi.createMaintenance({ vehicleId: id!, ...payload });
        toast.success(t('pages:vehicles.detail.maintenance.toast.added'));
      }
      setMainDialog(false);
      load();
    } catch (err) {
      toast.error(apiError(err, editingMain ? t('pages:vehicles.detail.maintenance.toast.updateFailed') : t('pages:vehicles.detail.maintenance.toast.addFailed')));
    } finally {
      setMainSaving(false);
    }
  };

  const handleDeleteMaintenance = async (recId: string) => {
    if (!(await confirm({
      title: t('pages:vehicles.detail.maintenance.confirmDelete.title'),
      description: t('pages:vehicles.detail.maintenance.confirmDelete.description'),
      confirmText: t('pages:vehicles.detail.maintenance.confirmDelete.confirm'), tone: 'destructive',
    }))) return;
    try {
      await vehiclesApi.deleteMaintenance(recId);
      toast.success(t('pages:vehicles.detail.maintenance.toast.deleted'));
      load();
    } catch (err) {
      toast.error(apiError(err, t('pages:vehicles.detail.maintenance.toast.deleteFailed')));
    }
  };

  if (loading) return <div className="p-6 text-muted-foreground">{t('pages:vehicles.detail.loading')}</div>;
  if (!vehicle) return <div className="p-6 text-red-600">{t('pages:vehicles.detail.notFound')}</div>;

  const activeDriver = vehicle.driverAssignments?.find((a: any) => a.isActive);
  const dash = '—';

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard/vehicles')}>
            <ArrowLeft className="w-4 h-4 me-1 rtl:rotate-180" /> {t('common:actions.back')}
          </Button>
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Truck className="w-5 h-5 text-primary" />
              {vehicle.registrationNumber}
            </h1>
            <p className="text-sm text-muted-foreground">{vehicle.make} {vehicle.model} · {vehicle.type?.replace('_', ' ')}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {statusBadge(vehicle.status)}
          {canWrite && (
            <>
              <Button size="sm" variant="outline" onClick={() => navigate(`/dashboard/vehicles/${id}/edit`)}>
                <Edit className="w-4 h-4 me-1" /> {t('common:actions.edit')}
              </Button>
              <Button size="sm" variant="destructive" onClick={handleDelete}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t('pages:vehicles.detail.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="driver">{t('pages:vehicles.detail.tabs.driver', { count: vehicle.driverAssignments?.length ?? 0 })}</TabsTrigger>
          <TabsTrigger value="documents">{t('pages:vehicles.detail.tabs.documents', { count: vehicle.documents?.length ?? 0 })}</TabsTrigger>
          <TabsTrigger value="maintenance">{t('pages:vehicles.detail.tabs.maintenance', { count: vehicle.maintenanceRecords?.length ?? 0 })}</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">{t('pages:vehicles.detail.info.title')}</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {[
                  [t('pages:vehicles.detail.info.year'), vehicle.year ?? dash],
                  [t('pages:vehicles.detail.info.color'), vehicle.color ?? dash],
                  [t('pages:vehicles.detail.info.vin'), vehicle.vin ?? dash],
                  [t('pages:vehicles.detail.info.fuelType'), vehicle.fuelType ? (enumLabel('fuelType', vehicle.fuelType) || vehicle.fuelType) : dash],
                  [t('pages:vehicles.detail.info.currentMileage'), vehicle.currentMileage ? t('pages:vehicles.detail.info.kmSuffix', { value: formatNumber(vehicle.currentMileage) }) : dash],
                  [t('pages:vehicles.detail.info.agency'), vehicle.agency?.name ?? dash],
                ].map(([label, value]) => (
                  <div key={label as string} className="flex justify-between">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-medium">{value}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">{t('pages:vehicles.detail.compliance.title')}</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">{t('pages:vehicles.detail.compliance.motExpiry')}</span>
                  <ExpiryCell date={vehicle.motExpiryDate} />
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">{t('pages:vehicles.detail.compliance.taxExpiry')}</span>
                  <ExpiryCell date={vehicle.taxExpiryDate} />
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">{t('pages:vehicles.detail.compliance.insuranceExpiry')}</span>
                  <ExpiryCell date={vehicle.insuranceExpiryDate} />
                </div>
              </CardContent>
            </Card>
          </div>

          {vehicle.notes && (
            <Card>
              <CardContent className="pt-4 text-sm text-muted-foreground">{vehicle.notes}</CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Driver Tab */}
        <TabsContent value="driver" className="space-y-4 mt-4">
          <div className="flex justify-between items-center">
            <h3 className="font-medium">{t('pages:vehicles.detail.driver.heading')}</h3>
            {canWrite && (
              <Button size="sm" onClick={() => {
                setDriverEmpId('');
                setDriverName('');
                setDriverSearch('');
                setPickerOpen(false);
                setAssignDialog(true);
              }}>
                <User className="w-4 h-4 me-2" /> {t('pages:vehicles.detail.driver.assignButton')}
              </Button>
            )}
          </div>

          {activeDriver && (
            <Card className="border-green-200 bg-green-50">
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-green-200 flex items-center justify-center">
                      <User className="w-5 h-5 text-green-700" />
                    </div>
                    <div>
                      <p className="font-medium">{activeDriver.employee.firstName} {activeDriver.employee.lastName}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('pages:vehicles.detail.driver.licensePrefix')}: {activeDriver.employee.licenseNumber ?? dash} · {t('pages:vehicles.detail.driver.since', { date: formatDate(activeDriver.startDate) })}
                      </p>
                    </div>
                    <Badge className="bg-green-200 text-green-800 text-xs">{t('pages:vehicles.detail.driver.active')}</Badge>
                  </div>
                  {canWrite && (
                    <Button size="sm" variant="outline" onClick={() => handleUnassign(activeDriver.id)}>
                      {t('pages:vehicles.detail.driver.endAssignment')}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('pages:vehicles.detail.driver.columns.driver')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.driver.columns.licence')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.driver.columns.from')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.driver.columns.to')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.driver.columns.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vehicle.driverAssignments?.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{t('pages:vehicles.detail.driver.empty')}</TableCell></TableRow>
              ) : vehicle.driverAssignments?.map((a: any) => (
                <TableRow key={a.id}>
                  <TableCell>{a.employee.firstName} {a.employee.lastName}</TableCell>
                  <TableCell className="font-mono text-sm">{a.employee.licenseNumber ?? dash}</TableCell>
                  <TableCell className="text-sm">{formatDate(a.startDate)}</TableCell>
                  <TableCell className="text-sm">{a.endDate ? formatDate(a.endDate) : dash}</TableCell>
                  <TableCell>
                    <span className={`text-xs px-2 py-0.5 rounded ${a.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                      {a.isActive ? t('pages:vehicles.detail.driver.active') : t('pages:vehicles.detail.driver.ended')}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>

        {/* Documents Tab */}
        <TabsContent value="documents" className="space-y-4 mt-4">
          <div className="flex justify-between items-center">
            <h3 className="font-medium">{t('pages:vehicles.detail.documents.heading')}</h3>
            {canWrite && (
              <Button size="sm" onClick={openAddDoc}>
                <Plus className="w-4 h-4 me-2" /> {t('pages:vehicles.detail.documents.addButton')}
              </Button>
            )}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('pages:vehicles.detail.documents.columns.name')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.documents.columns.type')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.documents.columns.issuer')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.documents.columns.issued')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.documents.columns.expires')}</TableHead>
                <TableHead className="text-end">{t('pages:vehicles.detail.documents.columns.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vehicle.documents?.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">{t('pages:vehicles.detail.documents.empty')}</TableCell></TableRow>
              ) : vehicle.documents?.map((doc: any) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">{doc.name}</TableCell>
                  <TableCell className="text-sm">{doc.documentType}</TableCell>
                  <TableCell className="text-sm">{doc.issuer ?? dash}</TableCell>
                  <TableCell className="text-sm">{doc.issuedDate ? formatDate(doc.issuedDate) : dash}</TableCell>
                  <TableCell><ExpiryCell date={doc.expiryDate} /></TableCell>
                  <TableCell className="text-end">
                    <div className="flex items-center justify-end gap-1">
                      {doc.fileUrl && (
                        <a
                          href={doc.fileUrl?.startsWith('http') ? doc.fileUrl : `${(import.meta.env.VITE_API_URL as string | undefined)?.replace('/api/v1', '') ?? 'http://localhost:3000'}${doc.fileUrl}`}
                          target="_blank"
                          rel="noreferrer"
                          download={doc.fileName ?? undefined}
                          className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-accent"
                          title={t('pages:vehicles.detail.documents.downloadTitle', { name: doc.fileName ?? t('pages:vehicles.detail.documents.defaultFileName') })}
                        >
                          <Download className="w-4 h-4 text-muted-foreground" />
                        </a>
                      )}
                      {canWrite && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => openEditDoc(doc)}>
                            <Edit className="w-4 h-4 text-muted-foreground" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleDeleteDoc(doc.id)}>
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>

        {/* Maintenance Tab */}
        <TabsContent value="maintenance" className="space-y-4 mt-4">
          <div className="flex justify-between items-center">
            <h3 className="font-medium">{t('pages:vehicles.detail.maintenance.heading')}</h3>
            {canWrite && (
              <Button size="sm" onClick={openAddMaintenance}>
                <Plus className="w-4 h-4 me-2" /> {t('pages:vehicles.detail.maintenance.addButton')}
              </Button>
            )}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('pages:vehicles.detail.maintenance.columns.type')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.maintenance.columns.status')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.maintenance.columns.scheduled')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.maintenance.columns.completed')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.maintenance.columns.workshop')}</TableHead>
                <TableHead>{t('pages:vehicles.detail.maintenance.columns.cost')}</TableHead>
                {canWrite && <TableHead className="text-end">{t('pages:vehicles.detail.maintenance.columns.actions')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {vehicle.maintenanceRecords?.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">{t('pages:vehicles.detail.maintenance.empty')}</TableCell></TableRow>
              ) : vehicle.maintenanceRecords?.map((rec: any) => (
                <TableRow key={rec.id}>
                  <TableCell className="font-medium text-sm">{rec.maintenanceType?.name ?? rec.description ?? dash}</TableCell>
                  <TableCell>{mStatusBadge(rec.status)}</TableCell>
                  <TableCell className="text-sm">{rec.scheduledDate ? formatDate(rec.scheduledDate) : dash}</TableCell>
                  <TableCell className="text-sm">{rec.completedDate ? formatDate(rec.completedDate) : dash}</TableCell>
                  <TableCell className="text-sm">{rec.workshop?.name ?? dash}</TableCell>
                  <TableCell className="text-sm">{rec.cost ? formatCurrency(rec.cost, 'GBP') : dash}</TableCell>
                  {canWrite && (
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEditMaintenance(rec)}>
                          <Edit className="w-4 h-4 text-muted-foreground" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleDeleteMaintenance(rec.id)}>
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>

      {/* Assign Driver Dialog */}
      <Dialog open={assignDialog} onOpenChange={(open) => {
        setAssignDialog(open);
        if (!open) { setPickerOpen(false); setDriverSearch(''); }
      }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('pages:vehicles.detail.driver.dialog.title')}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            {/* Searchable employee picker */}
            <div className="space-y-1" ref={pickerRef}>
              <Label>{t('pages:vehicles.detail.driver.dialog.selectDriver')} *</Label>
              {/* Selected employee display / search input */}
              <div className="relative">
                <div
                  className="flex items-center border rounded-md px-3 py-2 gap-2 cursor-text bg-background focus-within:ring-2 focus-within:ring-ring"
                  onClick={() => setPickerOpen(true)}
                >
                  <Search className="w-4 h-4 text-muted-foreground shrink-0" />
                  {driverSelectedName && !pickerOpen ? (
                    <span className="text-sm flex-1">{driverSelectedName}</span>
                  ) : (
                    <input
                      autoFocus={pickerOpen}
                      className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
                      placeholder={t('pages:vehicles.detail.driver.dialog.searchPlaceholder')}
                      value={driverSearch}
                      onChange={(e) => { setDriverSearch(e.target.value); setPickerOpen(true); }}
                      onFocus={() => setPickerOpen(true)}
                    />
                  )}
                  {driverSelectedName && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground text-xs ms-auto"
                      onClick={(e) => { e.stopPropagation(); setDriverEmpId(''); setDriverName(''); setDriverSearch(''); setPickerOpen(true); }}
                    >✕</button>
                  )}
                </div>

                {/* Dropdown */}
                {pickerOpen && (
                  <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-md max-h-60 overflow-y-auto">
                    {driverLoading ? (
                      <div className="py-3 text-center text-sm text-muted-foreground">{t('pages:vehicles.detail.driver.dialog.searching')}</div>
                    ) : driverOptions.length === 0 ? (
                      <div className="py-3 text-center text-sm text-muted-foreground">{t('pages:vehicles.detail.driver.dialog.noDriversFound')}</div>
                    ) : driverOptions.map((emp: any) => (
                      <button
                        key={emp.id}
                        type="button"
                        className={`w-full text-start px-3 py-2 text-sm hover:bg-accent flex items-start gap-2 ${driverEmployeeId === emp.id ? 'bg-accent font-medium' : ''}`}
                        onClick={() => {
                          setDriverEmpId(emp.id);
                          setDriverName(`${emp.firstName} ${emp.lastName}`);
                          setDriverSearch('');
                          setPickerOpen(false);
                        }}
                      >
                        <User className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                        <div>
                          <p className="font-medium">{emp.firstName} {emp.lastName}</p>
                          <p className="text-xs text-muted-foreground">
                            {[
                              emp.jobType?.name,
                              emp.licenseCategory,
                              emp.licenseNumber,
                            ].filter(Boolean).join(' · ') || t('pages:vehicles.detail.driver.dialog.defaultRoleLabel')}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <Label>{t('pages:vehicles.detail.driver.dialog.startDate')}</Label>
              <DateInput value={driverStartDate} onChange={(e) => setDriverStart(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignDialog(false)}>{t('common:actions.cancel')}</Button>
            <Button onClick={handleAssignDriver} disabled={assigningSaving || !driverEmployeeId}>
              {assigningSaving ? t('pages:vehicles.detail.driver.dialog.assigning') : t('pages:vehicles.detail.driver.dialog.assignButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add / Edit Document Dialog */}
      <Dialog open={docDialog} onOpenChange={(open) => { setDocDialog(open); if (!open) setDocFile(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingDoc ? t('pages:vehicles.detail.documents.dialog.editTitle') : t('pages:vehicles.detail.documents.dialog.addTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>{t('pages:vehicles.detail.documents.dialog.name')} *</Label>
              <Input value={docForm.name} onChange={(e) => setDocForm((f) => ({ ...f, name: e.target.value }))} placeholder={t('pages:vehicles.detail.documents.dialog.namePh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.detail.documents.dialog.type')}</Label>
              <Select value={docForm.documentType} onValueChange={(v) => setDocForm((f) => ({ ...f, documentType: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['MOT', 'Insurance', 'Road Tax', 'Registration', 'Inspection', 'Other'].map((tp) =>
                    <SelectItem key={tp} value={tp}>{tp}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('pages:vehicles.detail.documents.dialog.issuedDate')}</Label>
                <DateInput value={docForm.issuedDate} onChange={(e) => setDocForm((f) => ({ ...f, issuedDate: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('pages:vehicles.detail.documents.dialog.expiryDate')}</Label>
                <DateInput value={docForm.expiryDate} onChange={(e) => setDocForm((f) => ({ ...f, expiryDate: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.detail.documents.dialog.issuer')}</Label>
              <Input value={docForm.issuer} onChange={(e) => setDocForm((f) => ({ ...f, issuer: e.target.value }))} placeholder={t('pages:vehicles.detail.documents.dialog.issuerPh')} />
            </div>
            <div className="space-y-1">
              <Label>{t('pages:vehicles.detail.documents.dialog.notes')}</Label>
              <Input value={docForm.notes} onChange={(e) => setDocForm((f) => ({ ...f, notes: e.target.value }))} placeholder={t('pages:vehicles.detail.documents.dialog.notesPh')} />
            </div>
            {!editingDoc && (
              <div className="space-y-1">
                <Label>{t('pages:vehicles.detail.documents.dialog.fileLabel')} <span className="text-muted-foreground text-xs">{t('pages:vehicles.detail.documents.dialog.fileHint')}</span></Label>
                <input
                  type="file"
                  className="block w-full text-sm text-muted-foreground file:me-3 file:py-1 file:px-3 file:rounded file:border file:border-input file:text-sm file:bg-background file:cursor-pointer hover:file:bg-accent cursor-pointer"
                  onChange={(e) => setDocFile(e.target.files?.[0] ?? null)}
                />
                {docFile && (
                  <p className="text-xs text-muted-foreground">{t('pages:vehicles.detail.documents.dialog.fileSize', { name: docFile.name, size: (docFile.size / 1024).toFixed(0) })}</p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDocDialog(false); setDocFile(null); }}>{t('common:actions.cancel')}</Button>
            <Button onClick={handleSaveDoc} disabled={docSaving}>
              {docSaving ? t('pages:vehicles.detail.documents.dialog.saving') : editingDoc ? t('pages:vehicles.detail.documents.dialog.saveButton') : t('pages:vehicles.detail.documents.dialog.addButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add / Edit Maintenance Dialog */}
      <Dialog open={mainDialog} onOpenChange={setMainDialog}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 py-4 border-b">
            <DialogTitle className="text-lg">{editingMain ? t('pages:vehicles.detail.maintenance.dialog.editTitle') : t('pages:vehicles.detail.maintenance.dialog.addTitle')}</DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
            {/* Section: Service Details */}
            <section className="space-y-3">
              <div className="flex items-center gap-2 pb-1 border-b">
                <Wrench className="w-4 h-4 text-muted-foreground" />
                <h4 className="font-semibold text-sm">{t('pages:vehicles.detail.maintenance.dialog.sectionService')}</h4>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.type')}</Label>
                  <Select value={mainForm.maintenanceTypeId || 'none'} onValueChange={(v) => setMainForm((f: any) => ({ ...f, maintenanceTypeId: v === 'none' ? '' : v }))}>
                    <SelectTrigger><SelectValue placeholder={t('pages:vehicles.detail.maintenance.dialog.typePh')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('pages:vehicles.detail.maintenance.dialog.notSpecified')}</SelectItem>
                      {maintenanceTypes.map((mt: any) => <SelectItem key={mt.id} value={mt.id}>{mt.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.status')}</Label>
                  <Select value={mainForm.status} onValueChange={(v) => setMainForm((f: any) => ({ ...f, status: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MAINTENANCE_STATUSES.map((s) => <SelectItem key={s} value={s}>{enumLabel('maintenanceStatus', s) || s.replace('_', ' ')}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.workshop')}</Label>
                  <Select value={mainForm.workshopId || 'none'} onValueChange={(v) => setMainForm((f: any) => ({ ...f, workshopId: v === 'none' ? '' : v }))}>
                    <SelectTrigger><SelectValue placeholder={t('pages:vehicles.detail.maintenance.dialog.workshopPh')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('pages:vehicles.detail.maintenance.dialog.notSpecified')}</SelectItem>
                      {workshops.map((w: any) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.mileageAtService')}</Label>
                  <Input type="number" value={mainForm.mileageAtService} onChange={(e) => setMainForm((f: any) => ({ ...f, mileageAtService: e.target.value }))} placeholder={t('pages:vehicles.detail.maintenance.dialog.mileagePh')} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.scheduledDate')}</Label>
                  <DateInput value={mainForm.scheduledDate} onChange={(e) => setMainForm((f: any) => ({ ...f, scheduledDate: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.completedDate')}</Label>
                  <DateInput value={mainForm.completedDate} onChange={(e) => setMainForm((f: any) => ({ ...f, completedDate: e.target.value }))} />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.totalCost')}</Label>
                  <Input type="number" step="0.01" value={mainForm.cost} onChange={(e) => setMainForm((f: any) => ({ ...f, cost: e.target.value }))} placeholder={t('pages:vehicles.detail.maintenance.dialog.totalCostPh')} />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.description')}</Label>
                  <Input value={mainForm.description} onChange={(e) => setMainForm((f: any) => ({ ...f, description: e.target.value }))} placeholder={t('pages:vehicles.detail.maintenance.dialog.descriptionPh')} />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.workDescription')}</Label>
                  <textarea
                    className="flex min-h-[70px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={mainForm.workDescription}
                    onChange={(e) => setMainForm((f: any) => ({ ...f, workDescription: e.target.value }))}
                    placeholder={t('pages:vehicles.detail.maintenance.dialog.workDescriptionPh')}
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.notes')}</Label>
                  <Input value={mainForm.notes} onChange={(e) => setMainForm((f: any) => ({ ...f, notes: e.target.value }))} placeholder={t('pages:vehicles.detail.maintenance.dialog.notesPh')} />
                </div>
              </div>
            </section>

            {/* Section: Driver & Logistics */}
            <section className="space-y-3">
              <div className="flex items-center gap-2 pb-1 border-b">
                <User className="w-4 h-4 text-muted-foreground" />
                <h4 className="font-semibold text-sm">{t('pages:vehicles.detail.maintenance.dialog.sectionDriver')}</h4>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.serviceDriver')}</Label>
                  <Select value={mainForm.driverId || 'other'} onValueChange={(v) => setMainForm((f: any) => ({ ...f, driverId: v === 'other' ? '' : v, driverNameOverride: v === 'other' ? f.driverNameOverride : '' }))}>
                    <SelectTrigger><SelectValue placeholder={t('pages:vehicles.detail.maintenance.dialog.selectDriver')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="other">{t('pages:vehicles.detail.maintenance.dialog.otherExternal')}</SelectItem>
                      {drivers.map((d: any) => <SelectItem key={d.id} value={d.id}>{d.firstName} {d.lastName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.externalDriverName')}</Label>
                  <Input
                    value={mainForm.driverNameOverride}
                    onChange={(e) => setMainForm((f: any) => ({ ...f, driverNameOverride: e.target.value }))}
                    placeholder={t('pages:vehicles.detail.maintenance.dialog.driverNamePh')}
                    disabled={!!mainForm.driverId}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.dropOffDriver')}</Label>
                  <Select value={mainForm.dropOffDriverId || 'other'} onValueChange={(v) => setMainForm((f: any) => ({ ...f, dropOffDriverId: v === 'other' ? '' : v, dropOffDriverNameOverride: v === 'other' ? f.dropOffDriverNameOverride : '' }))}>
                    <SelectTrigger><SelectValue placeholder={t('pages:vehicles.detail.maintenance.dialog.selectDriver')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="other">{t('pages:vehicles.detail.maintenance.dialog.otherNone')}</SelectItem>
                      {drivers.map((d: any) => <SelectItem key={d.id} value={d.id}>{d.firstName} {d.lastName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.dropOffDriverName')}</Label>
                  <Input
                    value={mainForm.dropOffDriverNameOverride}
                    onChange={(e) => setMainForm((f: any) => ({ ...f, dropOffDriverNameOverride: e.target.value }))}
                    placeholder={t('pages:vehicles.detail.maintenance.dialog.namePh')}
                    disabled={!!mainForm.dropOffDriverId}
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.dropOffDateTime')}</Label>
                  <Input type="datetime-local" value={mainForm.dropOffDateTime} onChange={(e) => setMainForm((f: any) => ({ ...f, dropOffDateTime: e.target.value }))} />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.pickUpDriver')}</Label>
                  <Select value={mainForm.pickUpDriverId || 'other'} onValueChange={(v) => setMainForm((f: any) => ({ ...f, pickUpDriverId: v === 'other' ? '' : v, pickUpDriverNameOverride: v === 'other' ? f.pickUpDriverNameOverride : '' }))}>
                    <SelectTrigger><SelectValue placeholder={t('pages:vehicles.detail.maintenance.dialog.selectDriver')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="other">{t('pages:vehicles.detail.maintenance.dialog.otherNone')}</SelectItem>
                      {drivers.map((d: any) => <SelectItem key={d.id} value={d.id}>{d.firstName} {d.lastName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.pickUpDriverName')}</Label>
                  <Input
                    value={mainForm.pickUpDriverNameOverride}
                    onChange={(e) => setMainForm((f: any) => ({ ...f, pickUpDriverNameOverride: e.target.value }))}
                    placeholder={t('pages:vehicles.detail.maintenance.dialog.namePh')}
                    disabled={!!mainForm.pickUpDriverId}
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.pickUpDateTime')}</Label>
                  <Input type="datetime-local" value={mainForm.pickUpDateTime} onChange={(e) => setMainForm((f: any) => ({ ...f, pickUpDateTime: e.target.value }))} />
                </div>
              </div>
            </section>

            {/* Section: Approval */}
            <section className="space-y-3">
              <div className="flex items-center gap-2 pb-1 border-b">
                <FileText className="w-4 h-4 text-muted-foreground" />
                <h4 className="font-semibold text-sm">{t('pages:vehicles.detail.maintenance.dialog.sectionApproval')}</h4>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.approvedBy')}</Label>
                  <Select value={mainForm.approvedById || 'none'} onValueChange={(v) => setMainForm((f: any) => ({ ...f, approvedById: v === 'none' ? '' : v }))}>
                    <SelectTrigger><SelectValue placeholder={t('pages:vehicles.detail.maintenance.dialog.pendingApproval')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('pages:vehicles.detail.maintenance.dialog.pendingApproval')}</SelectItem>
                      {drivers.map((d: any) => <SelectItem key={d.id} value={d.id}>{d.firstName} {d.lastName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('pages:vehicles.detail.maintenance.dialog.approvalDate')}</Label>
                  <DateInput value={mainForm.approvedAt} onChange={(e) => setMainForm((f: any) => ({ ...f, approvedAt: e.target.value }))} />
                </div>
              </div>
            </section>
          </div>

          <DialogFooter className="px-6 py-4 border-t bg-muted/30">
            <Button variant="outline" onClick={() => setMainDialog(false)}>{t('common:actions.cancel')}</Button>
            <Button onClick={handleSaveMaintenance} disabled={mainSaving}>
              {mainSaving ? t('pages:vehicles.detail.maintenance.dialog.saving') : editingMain ? t('pages:vehicles.detail.maintenance.dialog.saveButton') : t('pages:vehicles.detail.maintenance.dialog.addButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
