import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { settingsApi } from '../../services/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { ArrowLeft, Plus, Trash2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '../../hooks/usePermissions';

export function SkillsSettings() {
  const { t } = useTranslation('pages');
  const { t: tc } = useTranslation('common');
  const { canEdit } = usePermissions();
  const isAdmin = canEdit('settings');
  const [skills, setSkills] = useState<string[]>([]);
  const [newSkill, setNewSkill] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    settingsApi.getAll().then((res: any) => {
      const arr: any[] = Array.isArray(res.form) ? res.form : [];
      const item = arr.find((i: any) => i.key === 'form.skills');
      if (item) {
        try { setSkills(JSON.parse(item.value)); } catch { setSkills([]); }
      } else {
        setSkills(['Microsoft Office', 'Email', 'GPS / Navigation', 'Transport Management Software', 'Tachograph Software', 'Teamwork', 'Communication', 'Time Management', 'Problem Solving', 'Customer Service', 'Self-motivated', 'Adaptability']);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const addSkill = () => {
    const trimmed = newSkill.trim();
    if (!trimmed || skills.includes(trimmed)) return;
    setSkills(prev => [...prev, trimmed]);
    setNewSkill('');
  };

  const removeSkill = (skill: string) => {
    setSkills(prev => prev.filter(s => s !== skill));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await settingsApi.update({ 'form.skills': JSON.stringify(skills) });
      toast.success(tc('toast.savedSuccessfully'));
    } catch {
      toast.error(tc('toast.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return <div className="text-center py-16 text-muted-foreground">{t('settings.skills.accessDenied')}</div>;
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/settings"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">{t('settings.skills.headerTitle')}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{t('settings.skills.headerSubtitle')}</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.skills.addCardTitle')}</CardTitle>
          <CardDescription>{t('settings.skills.addCardDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. Forklift Operator"
              value={newSkill}
              onChange={e => setNewSkill(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addSkill()}
            />
            <Button onClick={addSkill} className="gap-2">
              <Plus className="w-4 h-4" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current Skills ({skills.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('settings.skills.loading')}</p>
          ) : skills.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6 border-2 border-dashed rounded-lg">{t('settings.skills.empty')}</p>
          ) : (
            <div className="space-y-2">
              {skills.map(skill => (
                <div key={skill} className="flex items-center justify-between px-3 py-2 border rounded-lg">
                  <span className="text-sm">{skill}</span>
                  <button type="button" onClick={() => removeSkill(skill)} className="p-1 text-gray-400 hover:text-red-500">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Button onClick={handleSave} disabled={saving} className="gap-2">
        <Save className="w-4 h-4" />
        {saving ? t('settings.skills.saving') : t('settings.skills.saveChanges')}
      </Button>
    </div>
  );
}
