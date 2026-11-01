import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Plus, Edit, Trash2, GripVertical, Save, FileText, CheckCircle, AlertCircle, ShieldOff, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../../components/ui/dialog';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { usePermissions } from '../../hooks/usePermissions';

import { confirm } from '../../components/ui/ConfirmDialog';
interface WorkflowStage {
  id: string;
  name: string;
  description: string;
  color: string;
  order: number;
  requirements: {
    documents: string[];
    actions: string[];
    approvals: string[];
  };
}

const initialStages: WorkflowStage[] = [
  {
    id: 'S001',
    name: 'Application Review',
    description: 'Initial review of driver application',
    color: '#64748B',
    order: 1,
    requirements: {
      documents: ['Application Form'],
      actions: ['Initial Screening'],
      approvals: ['HR Review'],
    },
  },
  {
    id: 'S002',
    name: 'Document Verification',
    description: 'Verify all required documents',
    color: '#2563EB',
    order: 2,
    requirements: {
      documents: ['Passport', 'Driving License', 'Criminal Record'],
      actions: ['Document Verification'],
      approvals: ['Compliance Officer'],
    },
  },
  {
    id: 'S003',
    name: 'Interview',
    description: 'Conduct driver interview',
    color: '#8B5CF6',
    order: 3,
    requirements: {
      documents: [],
      actions: ['Schedule Interview', 'Conduct Interview'],
      approvals: ['Hiring Manager'],
    },
  },
  {
    id: 'S004',
    name: 'Medical Examination',
    description: 'Medical fitness verification',
    color: '#F59E0B',
    order: 4,
    requirements: {
      documents: ['Medical Certificate'],
      actions: ['Schedule Medical Exam'],
      approvals: ['Medical Officer'],
    },
  },
  {
    id: 'S005',
    name: 'Work Permit',
    description: 'Work permit application and processing',
    color: '#EC4899',
    order: 5,
    requirements: {
      documents: ['Work Permit Application', 'Employment Contract'],
      actions: ['Submit Application', 'Track Status'],
      approvals: ['Government Authority'],
    },
  },
  {
    id: 'S006',
    name: 'Visa Processing',
    description: 'Visa application and approval',
    color: '#06B6D4',
    order: 6,
    requirements: {
      documents: ['Visa Application', 'Embassy Appointment'],
      actions: ['Book Embassy Appointment', 'Submit Documents'],
      approvals: ['Embassy Approval'],
    },
  },
  {
    id: 'S007',
    name: 'Contract Signing',
    description: 'Employment contract finalization',
    color: '#22C55E',
    order: 7,
    requirements: {
      documents: ['Employment Contract', 'Terms Agreement'],
      actions: ['Sign Contract'],
      approvals: ['Legal Department'],
    },
  },
];

export function WorkflowManagement() {
  const { t } = useTranslation('common');
  const { t: tp } = useTranslation('pages');
  const { canEdit } = usePermissions();
  const navigate = useNavigate();
  const [stages, setStages] = useState<WorkflowStage[]>(initialStages);
  const [isAddStageOpen, setIsAddStageOpen] = useState(false);
  const [isEditRequirementsOpen, setIsEditRequirementsOpen] = useState(false);
  const [selectedStage, setSelectedStage] = useState<WorkflowStage | null>(null);
  const [draggedStage, setDraggedStage] = useState<string | null>(null);

  const [newStageName, setNewStageName] = useState('');
  const [newStageDescription, setNewStageDescription] = useState('');
  const [newStageColor, setNewStageColor] = useState('#2563EB');

  const handleAddStage = () => {
    const newStage: WorkflowStage = {
      id: `S${String(stages.length + 1).padStart(3, '0')}`,
      name: newStageName,
      description: newStageDescription,
      color: newStageColor,
      order: stages.length + 1,
      requirements: {
        documents: [],
        actions: [],
        approvals: [],
      },
    };
    setStages([...stages, newStage]);
    setIsAddStageOpen(false);
    setNewStageName('');
    setNewStageDescription('');
    setNewStageColor('#2563EB');
  };

  const handleDeleteStage = async (stageId: string) => {
    if (await confirm({
      title: t('confirm.deleteStageTitle'),
      description: t('confirm.deleteStageBodyGeneric'),
      confirmText: t('actions.delete'), tone: 'destructive',
    })) {
      setStages(stages.filter(s => s.id !== stageId));
    }
  };

  const handleDragStart = (stageId: string) => {
    setDraggedStage(stageId);
  };

  const handleDragOver = (e: React.DragEvent, targetStageId: string) => {
    e.preventDefault();
    if (!draggedStage || draggedStage === targetStageId) return;

    const draggedIndex = stages.findIndex(s => s.id === draggedStage);
    const targetIndex = stages.findIndex(s => s.id === targetStageId);

    const newStages = [...stages];
    const [removed] = newStages.splice(draggedIndex, 1);
    newStages.splice(targetIndex, 0, removed);

    // Update order
    newStages.forEach((stage, index) => {
      stage.order = index + 1;
    });

    setStages(newStages);
  };

  const handleDragEnd = () => {
    setDraggedStage(null);
  };

  const openRequirementsEditor = (stage: WorkflowStage) => {
    setSelectedStage(stage);
    setIsEditRequirementsOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-3xl font-semibold text-[#0F172A]">{tp('workflow.management.title')}</h1>
          </div>
          <p className="text-muted-foreground mt-1">{tp('workflow.management.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          {canEdit('workflow') && (
            <Button variant="outline" onClick={() => toast.success(tp('workflow.management.savedStub'))}>
              <Save className="w-4 h-4 me-2" />
              {t('saveChanges')}
            </Button>
          )}
          {canEdit('workflow') && (
          <Dialog open={isAddStageOpen} onOpenChange={setIsAddStageOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 me-2" />
                {tp('workflow.management.addStage')}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Add New Workflow Stage</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-4">
                <div>
                  <Label htmlFor="stageName">{tp('workflow.management.stageName')}</Label>
                  <Input
                    id="stageName"
                    placeholder="e.g., Background Check"
                    value={newStageName}
                    onChange={(e) => setNewStageName(e.target.value)}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="stageDescription">Description</Label>
                  <Input
                    id="stageDescription"
                    placeholder="Brief description of this stage"
                    value={newStageDescription}
                    onChange={(e) => setNewStageDescription(e.target.value)}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="stageColor">{tp('workflow.management.stageColor')}</Label>
                  <Select value={newStageColor} onValueChange={setNewStageColor}>
                    <SelectTrigger id="stageColor" className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="#2563EB">Blue</SelectItem>
                      <SelectItem value="#22C55E">Green</SelectItem>
                      <SelectItem value="#F59E0B">Orange</SelectItem>
                      <SelectItem value="#EF4444">Red</SelectItem>
                      <SelectItem value="#8B5CF6">Purple</SelectItem>
                      <SelectItem value="#EC4899">Pink</SelectItem>
                      <SelectItem value="#06B6D4">Cyan</SelectItem>
                      <SelectItem value="#64748B">Gray</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" onClick={() => setIsAddStageOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleAddStage}>{tp('workflow.management.addStage')}</Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
          )}
        </div>
      </div>

      {/* Info Alert */}
      <Card className="border-[#2563EB] bg-[#EFF6FF]">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-[#2563EB] mt-0.5" />
            <div>
              <p className="font-medium text-[#2563EB]">{tp('workflow.management.dragToReorder')}</p>
              <p className="text-sm text-muted-foreground mt-1">
                Use the drag handle to reorder workflow stages. Changes will be reflected across the entire system.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Workflow Stages */}
      <Card>
        <CardHeader>
          <CardTitle>Workflow Stages ({stages.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {stages.map((stage) => (
              <div
                key={stage.id}
                draggable={canEdit('workflow')}
                onDragStart={() => canEdit('workflow') && handleDragStart(stage.id)}
                onDragOver={(e) => canEdit('workflow') && handleDragOver(e, stage.id)}
                onDragEnd={handleDragEnd}
                className={`flex items-center gap-4 p-4 border rounded-lg hover:bg-[#F8FAFC] transition-colors ${
                  canEdit('workflow') ? 'cursor-move' : 'cursor-default'
                } ${draggedStage === stage.id ? 'opacity-50' : ''}`}
              >
                <GripVertical className={`w-5 h-5 flex-shrink-0 ${canEdit('workflow') ? 'text-muted-foreground' : 'text-muted-foreground/30'}`} />
                
                <div className="flex items-center gap-3 flex-1">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-semibold"
                    style={{ backgroundColor: stage.color }}
                  >
                    {stage.order}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-[#0F172A]">{stage.name}</h3>
                      <Badge variant="outline" style={{ borderColor: stage.color, color: stage.color }}>
                        Stage {stage.order}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mb-2">{stage.description}</p>
                    
                    <div className="flex items-center gap-4 text-sm">
                      <div className="flex items-center gap-1">
                        <FileText className="w-4 h-4 text-muted-foreground" />
                        <span>{stage.requirements.documents.length} documents</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <CheckCircle className="w-4 h-4 text-muted-foreground" />
                        <span>{stage.requirements.actions.length} actions</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <AlertCircle className="w-4 h-4 text-muted-foreground" />
                        <span>{stage.requirements.approvals.length} approvals</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {canEdit('workflow') && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openRequirementsEditor(stage)}
                    >
                      <Edit className="w-4 h-4 me-1" />
                      Edit Requirements
                    </Button>
                  )}
                  {canEdit('workflow') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteStage(stage.id)}
                    >
                      <Trash2 className="w-4 h-4 text-[#EF4444]" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Stage Requirements Editor Dialog */}
      <Dialog open={isEditRequirementsOpen} onOpenChange={setIsEditRequirementsOpen}>
        <DialogContent className="sm:max-w-[700px]">
          <DialogHeader>
            <DialogTitle>Edit Stage Requirements - {selectedStage?.name}</DialogTitle>
          </DialogHeader>
          {selectedStage && (
            <div className="space-y-6 pt-4">
              <div>
                <Label>Required Documents</Label>
                <div className="space-y-2 mt-2">
                  {selectedStage.requirements.documents.map((doc, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input value={doc} readOnly className="flex-1" />
                      <Button size="sm" variant="ghost">
                        <Trash2 className="w-4 h-4 text-[#EF4444]" />
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline">
                    <Plus className="w-4 h-4 me-1" />
                    Add Document
                  </Button>
                </div>
              </div>

              <div>
                <Label>Required Actions</Label>
                <div className="space-y-2 mt-2">
                  {selectedStage.requirements.actions.map((action, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input value={action} readOnly className="flex-1" />
                      <Button size="sm" variant="ghost">
                        <Trash2 className="w-4 h-4 text-[#EF4444]" />
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline">
                    <Plus className="w-4 h-4 me-1" />
                    Add Action
                  </Button>
                </div>
              </div>

              <div>
                <Label>Required Approvals</Label>
                <div className="space-y-2 mt-2">
                  {selectedStage.requirements.approvals.map((approval, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input value={approval} readOnly className="flex-1" />
                      <Button size="sm" variant="ghost">
                        <Trash2 className="w-4 h-4 text-[#EF4444]" />
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline">
                    <Plus className="w-4 h-4 me-1" />
                    Add Approval
                  </Button>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button variant="outline" onClick={() => setIsEditRequirementsOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setIsEditRequirementsOpen(false)}>
                  Save Requirements
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
