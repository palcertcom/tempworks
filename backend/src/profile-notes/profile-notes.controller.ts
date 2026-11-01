import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile,
  UseGuards, UseInterceptors, Request, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProfileNotesService } from './profile-notes.service';
import {
  CreateProfileNoteDto, UpdateProfileNoteDto, NOTE_OWNERS, NoteOwner,
} from './dto/profile-note.dto';

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB

@ApiTags('Profile Notes')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('profile-notes')
export class ProfileNotesController {
  constructor(private readonly svc: ProfileNotesService) {}

  @Get()
  @ApiOperation({ summary: 'List notes for a profile owner' })
  @ApiQuery({ name: 'ownerType', enum: NOTE_OWNERS })
  @ApiQuery({ name: 'ownerId' })
  list(
    @Query('ownerType') ownerType: NoteOwner,
    @Query('ownerId') ownerId: string,
    @Request() req: any,
  ) {
    if (!ownerType || !ownerId) throw new BadRequestException('ownerType and ownerId are required');
    if (!NOTE_OWNERS.includes(ownerType)) throw new BadRequestException('invalid ownerType');
    return this.svc.listByOwner(ownerType, ownerId, req.user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a profile note' })
  create(@Body() dto: CreateProfileNoteDto, @Request() req: any) {
    return this.svc.create(dto, req.user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a profile note' })
  update(@Param('id') id: string, @Body() dto: UpdateProfileNoteDto, @Request() req: any) {
    return this.svc.update(id, dto, req.user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a profile note' })
  remove(@Param('id') id: string, @Request() req: any) {
    return this.svc.remove(id, req.user);
  }

  @Post(':id/attachments')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Attach a file to a profile note' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES } }))
  attach(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.svc.addAttachment(id, file, req.user);
  }

  @Delete('attachments/:attachmentId')
  @ApiOperation({ summary: 'Remove a note attachment' })
  removeAttachment(@Param('attachmentId') attachmentId: string, @Request() req: any) {
    return this.svc.removeAttachment(attachmentId, req.user);
  }
}
