import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  profileNotesApi, NOTE_CATEGORIES, NOTE_PRIORITIES, NOTE_STATUSES,
  type ProfileNote, type ProfileNoteOwner, type ProfileNoteCategory,
  type ProfileNotePriority, type ProfileNoteStatus,
} from '../../services/api';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  Plus, Paperclip, Trash2, Pencil, ChevronDown, ChevronUp, X, Download,
} from 'lucide-react';

const PRIORITY_STYLES: Record<ProfileNotePriority, string> = {
  LOW:      'bg-slate-100 text-slate-700 border-slate-200',
  MEDIUM:   'bg-blue-100  text-blue-700  border-blue-200',
  HIGH:     'bg-amber-100 text-amber-800 border-amber-200',
  CRITICAL: 'bg-red-100   text-red-700   border-red-200',
};

const STATUS_STYLES: Record<ProfileNoteStatus, string> = {
  OPEN:        'bg-emerald-100 text-emerald-700 border-emerald-200',
  IN_PROGRESS: 'bg-blue-100    text-blue-700    border-blue-200',
  RESOLVED:    'bg-slate-100   text-slate-700   border-slate-200',
  CLOSED:      'bg-zinc-200    text-zinc-700    border-zinc-300',
};

const PREVIEW_LIMIT = 280;

interface Props {
  ownerType: ProfileNoteOwner;
  ownerId: string;
  /** When false, hide the add/edit/delete affordances. */
  canWrite?: boolean;
}

function formatUser(u: ProfileNote['createdBy'] | undefined | null): string {
  if (!u) return '—';
  const full = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || '—';
  const role = u.role?.name;
  return role ? `${full} (${role})` : full;
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ProfileNotesList({ ownerType, ownerId, canWrite = true }: Props) {
  const [notes, setNotes] = useState<ProfileNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Filters
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [priorityFilter, setPriorityFilter] = useState<string>('');
  const [statusFilter,   setStatusFilter]   = useState<string>('');

  // Create / Edit dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProfileNote | null>(null);
  const [draft, setDraft] = useState<{
    text: string; category: ProfileNoteCategory; priority: ProfileNotePriority; status: ProfileNoteStatus;
  }>({ text: '', category: 'GENERAL', priority: 'MEDIUM', status: 'OPEN' });
  const [submitting, setSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const rows = await profileNotesApi.list(ownerType, ownerId);
      setNotes(rows ?? []);
    } catch {
      toast.error('Failed to load notes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ownerType, ownerId]);

  const filtered = useMemo(() => notes.filter(n =>
       (!categoryFilter || n.category === categoryFilter)
    && (!priorityFilter || n.priority === priorityFilter)
    && (!statusFilter   || n.status   === statusFilter)
  ), [notes, categoryFilter, priorityFilter, statusFilter]);

  const openCreate = () => {
    setEditing(null);
    setDraft({ text: '', category: 'GENERAL', priority: 'MEDIUM', status: 'OPEN' });
    setPendingFile(null);
    setDialogOpen(true);
  };

  const openEdit = (note: ProfileNote) => {
    setEditing(note);
    setDraft({ text: note.text, category: note.category, priority: note.priority, status: note.status });
    setPendingFile(null);
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!draft.text.trim()) { toast.error('Note text is required'); return; }
    setSubmitting(true);
    try {
      let saved: ProfileNote;
      if (editing) {
        saved = await profileNotesApi.update(editing.id, draft);
      } else {
        saved = await profileNotesApi.create({ ownerType, ownerId, ...draft });
      }
      if (pendingFile) {
        try { await profileNotesApi.attach(saved.id, pendingFile); }
        catch { toast.error('Note saved but attachment upload failed'); }
      }
      toast.success(editing ? 'Note updated' : 'Note added');
      setDialogOpen(false);
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (note: ProfileNote) => {
    if (!confirm('Delete this note?')) return;
    try {
      await profileNotesApi.delete(note.id);
      setNotes(prev => prev.filter(n => n.id !== note.id));
      toast.success('Note deleted');
    } catch (err: any) {
      toast.error(err?.message || 'Delete failed');
    }
  };

  const handleAttachExisting = async (note: ProfileNote, file: File) => {
    try {
      const att = await profileNotesApi.attach(note.id, file);
      setNotes(prev => prev.map(n => n.id === note.id ? { ...n, attachments: [...n.attachments, att] } : n));
      toast.success('Attachment uploaded');
    } catch (err: any) {
      toast.error(err?.message || 'Upload failed');
    }
  };

  const handleRemoveAttachment = async (note: ProfileNote, attachmentId: string) => {
    try {
      await profileNotesApi.removeAttachment(attachmentId);
      setNotes(prev => prev.map(n => n.id === note.id
        ? { ...n, attachments: n.attachments.filter(a => a.id !== attachmentId) }
        : n,
      ));
    } catch (err: any) {
      toast.error(err?.message || 'Delete failed');
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle className="text-lg">Notes</CardTitle>
        {canWrite && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="w-4 h-4 me-1" /> Add Note
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={categoryFilter || '__all__'} onValueChange={(v) => setCategoryFilter(v === '__all__' ? '' : v)}>
            <SelectTrigger className="w-44 h-9 text-sm"><SelectValue placeholder="All categories" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All categories</SelectItem>
              {NOTE_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={priorityFilter || '__all__'} onValueChange={(v) => setPriorityFilter(v === '__all__' ? '' : v)}>
            <SelectTrigger className="w-40 h-9 text-sm"><SelectValue placeholder="All priorities" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All priorities</SelectItem>
              {NOTE_PRIORITIES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={statusFilter || '__all__'} onValueChange={(v) => setStatusFilter(v === '__all__' ? '' : v)}>
            <SelectTrigger className="w-40 h-9 text-sm"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              {NOTE_STATUSES.map(s => <SelectItem key={s} value={s}>{s.replace(/_/g, ' ')}</SelectItem>)}
            </SelectContent>
          </Select>
          {(categoryFilter || priorityFilter || statusFilter) && (
            <Button size="sm" variant="ghost" onClick={() => { setCategoryFilter(''); setPriorityFilter(''); setStatusFilter(''); }}>
              <X className="w-3.5 h-3.5 me-1" />Clear
            </Button>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No notes match the current filters.</p>
        ) : (
          <ul className="space-y-3">
            {filtered.map(note => {
              const isLong = note.text.length > PREVIEW_LIMIT;
              const isExpanded = !!expanded[note.id];
              const visibleText = !isLong || isExpanded ? note.text : note.text.slice(0, PREVIEW_LIMIT).trimEnd() + '…';
              const wasEdited = note.updatedBy && note.updatedAt && note.updatedAt !== note.createdAt;
              return (
                <li key={note.id} className="border rounded-lg p-3 bg-card">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <Badge variant="outline">{note.category}</Badge>
                    <Badge variant="outline" className={PRIORITY_STYLES[note.priority]}>{note.priority}</Badge>
                    <Badge variant="outline" className={STATUS_STYLES[note.status]}>{note.status.replace(/_/g, ' ')}</Badge>
                    <span className="text-xs text-muted-foreground ms-auto">
                      Added by <span className="font-medium">{formatUser(note.createdBy)}</span> · {formatDateTime(note.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{visibleText}</p>
                  {isLong && (
                    <button
                      type="button"
                      onClick={() => setExpanded(prev => ({ ...prev, [note.id]: !isExpanded }))}
                      className="text-xs text-blue-600 hover:underline mt-1 inline-flex items-center gap-1"
                    >
                      {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      {isExpanded ? 'Show less' : 'Show more'}
                    </button>
                  )}
                  {wasEdited && (
                    <p className="text-xs text-muted-foreground mt-2">
                      Last updated by <span className="font-medium">{formatUser(note.updatedBy)}</span> · {formatDateTime(note.updatedAt)}
                    </p>
                  )}
                  {note.attachments.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {note.attachments.map(att => (
                        <li key={att.id} className="flex items-center gap-2 text-xs bg-muted/50 rounded px-2 py-1">
                          <Paperclip className="w-3 h-3 shrink-0" />
                          <a href={att.fileUrl} target="_blank" rel="noopener noreferrer"
                             className="flex-1 truncate hover:underline" title={att.fileName}>
                            {att.fileName}
                          </a>
                          <span className="text-muted-foreground whitespace-nowrap">{humanFileSize(att.fileSize)}</span>
                          <a href={att.fileUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground" title="Open">
                            <Download className="w-3 h-3" />
                          </a>
                          {canWrite && (
                            <button onClick={() => handleRemoveAttachment(note, att.id)} className="text-red-400 hover:text-red-600" title="Remove">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canWrite && (
                    <div className="flex flex-wrap items-center gap-1 mt-2">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => openEdit(note)}>
                        <Pencil className="w-3 h-3 me-1" /> Edit
                      </Button>
                      <label className="inline-flex items-center gap-1 h-7 px-2 text-xs rounded hover:bg-muted cursor-pointer">
                        <Paperclip className="w-3 h-3" /> Attach
                        <input type="file" className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAttachExisting(note, f); e.target.value = ''; }} />
                      </label>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-red-500 hover:text-red-700" onClick={() => handleDelete(note)}>
                        <Trash2 className="w-3 h-3 me-1" /> Delete
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) setDialogOpen(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{editing ? 'Edit Note' : 'Add Note'}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={draft.category} onValueChange={(v) => setDraft(d => ({ ...d, category: v as ProfileNoteCategory }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{NOTE_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={draft.priority} onValueChange={(v) => setDraft(d => ({ ...d, priority: v as ProfileNotePriority }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{NOTE_PRIORITIES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={draft.status} onValueChange={(v) => setDraft(d => ({ ...d, status: v as ProfileNoteStatus }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{NOTE_STATUSES.map(s => <SelectItem key={s} value={s}>{s.replace(/_/g, ' ')}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Note *</Label>
              <Textarea value={draft.text} onChange={(e) => setDraft(d => ({ ...d, text: e.target.value }))} rows={6}
                placeholder="Type the note here…" />
            </div>
            {!editing && (
              <div className="space-y-1.5">
                <Label>Attachment (optional)</Label>
                <Input type="file"
                  onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)} />
                {pendingFile && (
                  <p className="text-xs text-muted-foreground">{pendingFile.name} ({humanFileSize(pendingFile.size)})</p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : editing ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
