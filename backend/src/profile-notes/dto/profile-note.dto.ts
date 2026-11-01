import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const NOTE_OWNERS    = ['EMPLOYEE', 'APPLICANT', 'CANDIDATE'] as const;
export const NOTE_CATEGORIES = [
  'HR', 'PERFORMANCE', 'WARNING', 'ATTENDANCE', 'PAYROLL',
  'VEHICLE', 'GENERAL', 'RECRUITMENT', 'MEDICAL', 'LEGAL',
] as const;
export const NOTE_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const NOTE_STATUSES   = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;

export type NoteOwner    = (typeof NOTE_OWNERS)[number];
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];
export type NotePriority = (typeof NOTE_PRIORITIES)[number];
export type NoteStatus   = (typeof NOTE_STATUSES)[number];

export class CreateProfileNoteDto {
  @ApiProperty({ enum: NOTE_OWNERS }) @IsEnum(NOTE_OWNERS) ownerType: NoteOwner;
  @ApiProperty() @IsString() ownerId: string;
  @ApiProperty() @IsString() @MinLength(1) text: string;
  @ApiPropertyOptional({ enum: NOTE_CATEGORIES }) @IsOptional() @IsEnum(NOTE_CATEGORIES) category?: NoteCategory;
  @ApiPropertyOptional({ enum: NOTE_PRIORITIES }) @IsOptional() @IsEnum(NOTE_PRIORITIES) priority?: NotePriority;
  @ApiPropertyOptional({ enum: NOTE_STATUSES })   @IsOptional() @IsEnum(NOTE_STATUSES)   status?: NoteStatus;
}

export class UpdateProfileNoteDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) text?: string;
  @ApiPropertyOptional({ enum: NOTE_CATEGORIES }) @IsOptional() @IsEnum(NOTE_CATEGORIES) category?: NoteCategory;
  @ApiPropertyOptional({ enum: NOTE_PRIORITIES }) @IsOptional() @IsEnum(NOTE_PRIORITIES) priority?: NotePriority;
  @ApiPropertyOptional({ enum: NOTE_STATUSES })   @IsOptional() @IsEnum(NOTE_STATUSES)   status?: NoteStatus;
}
