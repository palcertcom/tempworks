import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
  UseInterceptors, UploadedFile, BadRequestException, HttpCode, HttpStatus, Request,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryUpload, DOCUMENT_MIME } from '../common/storage/multer.config';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiBody, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { EmployeeWorkHistoryService } from './employee-work-history.service';
import { CreateWorkHistoryDto, UpdateWorkHistoryDto } from './dto/work-history.dto';

const READ_ROLES  = ['System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance'];
const WRITE_ROLES = ['System Admin', 'HR Manager', 'Recruiter'];

@ApiTags('Employee Work History')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('employees/:employeeId/work-history')
export class EmployeeWorkHistoryController {
  constructor(private readonly service: EmployeeWorkHistoryService) {}

  @Get()
  @Roles(...READ_ROLES)
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'List an employee\'s post-hire work history entries (newest first)' })
  @ApiParam({ name: 'employeeId' })
  list(@Param('employeeId') employeeId: string) {
    return this.service.list(employeeId);
  }

  @Post()
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Add a new work history entry for an employee' })
  @ApiParam({ name: 'employeeId' })
  create(@Param('employeeId') employeeId: string, @Body() dto: CreateWorkHistoryDto, @Request() req: any) {
    return this.service.create(employeeId, dto, req.user?.id);
  }

  @Patch(':entryId')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Update an existing work history entry' })
  update(
    @Param('employeeId') employeeId: string,
    @Param('entryId') entryId: string,
    @Body() dto: UpdateWorkHistoryDto,
    @Request() req: any,
  ) {
    return this.service.update(employeeId, entryId, dto, req.user?.id);
  }

  @Delete(':entryId')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a work history entry' })
  remove(
    @Param('employeeId') employeeId: string,
    @Param('entryId') entryId: string,
    @Request() req: any,
  ) {
    return this.service.remove(employeeId, entryId, req.user?.id);
  }

  @Post(':entryId/attachments')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Upload an attachment for a work history entry' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', memoryUpload({
    mimeTypes: DOCUMENT_MIME,
    maxBytes: 10 * 1024 * 1024,
  })))
  addAttachment(
    @Param('employeeId') employeeId: string,
    @Param('entryId') entryId: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    return this.service.addAttachment(employeeId, entryId, file, req.user?.id);
  }

  @Delete(':entryId/attachments/:attachmentId')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete an attachment on a work history entry' })
  removeAttachment(
    @Param('employeeId') employeeId: string,
    @Param('entryId') entryId: string,
    @Param('attachmentId') attachmentId: string,
    @Request() req: any,
  ) {
    return this.service.removeAttachment(employeeId, entryId, attachmentId, req.user?.id);
  }
}
