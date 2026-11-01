import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, HttpCode, HttpStatus, Request,
  UseInterceptors, UploadedFile, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryUpload, DOCUMENT_MIME } from '../common/storage/multer.config';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ContractsService } from './contracts.service';
import { CreateContractDto, UpdateContractDto } from './dto/contract.dto';

const READ_ROLES  = ['System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance'];
const WRITE_ROLES = ['System Admin', 'HR Manager', 'Recruiter'];

@ApiTags('Employment Contracts')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('employees/:employeeId/contracts')
export class ContractsController {
  constructor(private readonly service: ContractsService) {}

  @Get()
  @Roles(...READ_ROLES)
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'List an employee\'s contracts as a chronological timeline (oldest first)' })
  @ApiParam({ name: 'employeeId' })
  list(@Param('employeeId') employeeId: string) {
    return this.service.list(employeeId);
  }

  @Post()
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Add a contract record for an employee' })
  create(@Param('employeeId') employeeId: string, @Body() dto: CreateContractDto, @Request() req: any) {
    return this.service.create(employeeId, dto, req.user?.id);
  }

  @Post('with-document')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Add a contract and upload+link its contract document in one step' })
  @UseInterceptors(FileInterceptor('file', memoryUpload({ mimeTypes: DOCUMENT_MIME, maxBytes: 10 * 1024 * 1024 })))
  createWithDocument(
    @Param('employeeId') employeeId: string,
    @Body() dto: CreateContractDto,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    if (!file) throw new BadRequestException('No document file provided');
    return this.service.createWithDocument(employeeId, dto, file, req.user?.id);
  }

  @Patch(':contractId')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Update a contract record' })
  update(
    @Param('employeeId') employeeId: string,
    @Param('contractId') contractId: string,
    @Body() dto: UpdateContractDto,
    @Request() req: any,
  ) {
    return this.service.update(employeeId, contractId, dto, req.user?.id);
  }

  @Patch(':contractId/with-document')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Update a contract and upload+link a (new) contract document' })
  @UseInterceptors(FileInterceptor('file', memoryUpload({ mimeTypes: DOCUMENT_MIME, maxBytes: 10 * 1024 * 1024 })))
  updateWithDocument(
    @Param('employeeId') employeeId: string,
    @Param('contractId') contractId: string,
    @Body() dto: UpdateContractDto,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    if (!file) throw new BadRequestException('No document file provided');
    return this.service.updateWithDocument(employeeId, contractId, dto, file, req.user?.id);
  }

  @Delete(':contractId')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a contract record' })
  remove(
    @Param('employeeId') employeeId: string,
    @Param('contractId') contractId: string,
    @Request() req: any,
  ) {
    return this.service.remove(employeeId, contractId, req.user?.id);
  }
}
