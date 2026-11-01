import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useTenantSyncVersion } from '../../contexts/TenantSyncContext';
import { ArrowLeft, Plus, Pencil, Trash2, Building2, Star, StarOff } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Badge } from '../../components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { companyProfilesApi, type CompanyExportProfile } from '../../services/api';
import { SuperUserTenantField, isSuperUser } from '../../components/ui/super-user-tenant-field';
import { TenantFilterSelect } from '../../components/ui/tenant-filter-select';
import { useSuperUserTenantFilter } from '../../hooks/useSuperUserTenantFilter';

const EMPTY: Partial<CompanyExportProfile> = {
  name: '', legalName: '', addressLine1: '', addressLine2: '',
  city: '', postalCode: '', country: '',
  phone: '', email: '', vatNumber: '', registrationNumber: '',
  footer: '', isDefault: false,
};

export function CompanyProfiles() {
  const [profiles, setProfiles] = useState<CompanyExportProfile[]>([]);
  const tenantVersion = useTenantSyncVersion();
  const tenant = useSuperUserTenantFilter();
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<Partial<CompanyExportProfile> | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CompanyExportProfile | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await companyProfilesApi.list(
        tenant.isPlatformSuper && tenant.tenantFilter ? { tenantId: tenant.tenantFilter } : {},
      );
      setProfiles(list ?? []);
    } catch {
      toast.error('Failed to load company profiles');
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); }, [tenantVersion, tenant.tenantFilter]);

  const handleSave = async () => {
    if (!edit) return;
    if (!edit.name?.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    try {
      if (edit.id) {
        await companyProfilesApi.update(edit.id, edit);
        toast.success('Profile updated');
      } else {
        await companyProfilesApi.create(edit);
        toast.success('Profile created');
      }
      setEdit(null);
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await companyProfilesApi.delete(deleteTarget.id);
      toast.success('Profile removed');
      setDeleteTarget(null);
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Delete failed');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/settings"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold text-[#0F172A]">Company Export Profiles</h1>
          <p className="text-muted-foreground mt-1">
            Company-details blocks that appear in the header of exported Excel timesheets. Create one per legal entity / client company that issues timesheets.
          </p>
        </div>
        {tenant.isPlatformSuper && (
          <TenantFilterSelect value={tenant.tenantFilter} onChange={tenant.setTenantFilter} options={tenant.tenantOptions} />
        )}
        <Button onClick={() => setEdit({ ...EMPTY })}>
          <Plus className="w-4 h-4 me-1" />
          New Profile
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-blue-600" />
            Profiles
          </CardTitle>
          <CardDescription>
            The profile picked at export time replaces the workbook header. Mark one as default to pre-select it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
          ) : profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No profiles yet. Create one to add company details to exported timesheets.
            </p>
          ) : (
            <div className="space-y-2">
              {profiles.map((p) => (
                <div key={p.id} className="flex items-start gap-3 p-3 border rounded-md hover:bg-muted/30">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <strong>{p.name}</strong>
                      {p.isDefault && (
                        <Badge className="bg-amber-100 text-amber-700 border-amber-200">
                          <Star className="w-3 h-3 me-1" />
                          Default
                        </Badge>
                      )}
                      {tenant.isPlatformSuper && (
                        <Badge variant="outline" className="text-xs">
                          {p.tenantId
                            ? (tenant.tenantNameById[p.tenantId] ?? p.tenantId)
                            : 'Global (no tenant)'}
                        </Badge>
                      )}
                    </div>
                    {p.legalName && p.legalName !== p.name && (
                      <p className="text-xs text-muted-foreground">{p.legalName}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {[p.addressLine1, p.city, p.country].filter(Boolean).join(' · ') || <span className="italic">no address</span>}
                    </p>
                    {(p.phone || p.email) && (
                      <p className="text-xs text-muted-foreground">
                        {[p.phone, p.email].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setEdit({ ...p })}>
                    <Pencil className="w-3.5 h-3.5 me-1" />
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(p)}
                    className="text-red-500 hover:text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit / Create dialog */}
      <Dialog open={!!edit} onOpenChange={(o) => { if (!o) setEdit(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{edit?.id ? 'Edit Profile' : 'New Company Profile'}</DialogTitle>
          </DialogHeader>
          {edit && (
            <div className="space-y-3 py-2 text-sm max-h-[60vh] overflow-y-auto">
              <div className="space-y-1.5">
                <Label>Display Name *</Label>
                <Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. TempWorks s.r.o." />
              </div>
              <div className="space-y-1.5">
                <Label>Legal Name</Label>
                <Input value={edit.legalName ?? ''} onChange={(e) => setEdit({ ...edit, legalName: e.target.value })} placeholder="Full legal entity name as shown on invoices" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Address Line 1</Label>
                  <Input value={edit.addressLine1 ?? ''} onChange={(e) => setEdit({ ...edit, addressLine1: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Address Line 2</Label>
                  <Input value={edit.addressLine2 ?? ''} onChange={(e) => setEdit({ ...edit, addressLine2: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>City</Label>
                  <Input value={edit.city ?? ''} onChange={(e) => setEdit({ ...edit, city: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Postal Code</Label>
                  <Input value={edit.postalCode ?? ''} onChange={(e) => setEdit({ ...edit, postalCode: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Country</Label>
                  <Input value={edit.country ?? ''} onChange={(e) => setEdit({ ...edit, country: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Phone</Label>
                  <Input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Email</Label>
                  <Input value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>VAT Number</Label>
                  <Input value={edit.vatNumber ?? ''} onChange={(e) => setEdit({ ...edit, vatNumber: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Registration No.</Label>
                  <Input value={edit.registrationNumber ?? ''} onChange={(e) => setEdit({ ...edit, registrationNumber: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Footer note (optional)</Label>
                <Textarea
                  value={edit.footer ?? ''}
                  onChange={(e) => setEdit({ ...edit, footer: e.target.value })}
                  rows={2}
                  placeholder="Bank details / IBAN / extra disclaimer printed under the daily grid"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={!!edit.isDefault}
                  onChange={(e) => setEdit({ ...edit, isDefault: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300"
                />
                {edit.isDefault ? <Star className="w-4 h-4 text-amber-500" /> : <StarOff className="w-4 h-4 text-muted-foreground" />}
                <span>Set as default profile</span>
              </label>
              {/* SUPER-only Tenant selector (#34). Defaults to active tenant;
                  hidden for everyone else (backend re-checks). */}
              <SuperUserTenantField
                value={(edit as any).tenantId ?? ''}
                onChange={(v) => setEdit({ ...(edit as any), tenantId: v })}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : edit?.id ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-red-600 flex items-center gap-2">
              <Trash2 className="w-5 h-5" />
              Delete Company Profile
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Remove <strong>{deleteTarget?.name}</strong>? Previously exported workbooks are unaffected; new exports won't have this option in the dropdown.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
