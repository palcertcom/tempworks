import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Res, Request, Headers,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AttendanceService } from './attendance.service';
import { resolveAcceptLanguage } from '../common/i18n/server-translate';
import {
  FilterAttendanceEmployeesDto,
  GetEmployeeAttendanceDto,
  UpsertAttendanceDto,
  UpdateAttendanceDto,
  BulkUpsertAttendanceDto,
  BulkApplyAttendanceDto,
  LockPeriodDto,
  ExportAttendanceDto,
} from './dto/attendance.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

const READ_ROLES   = ['System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter'];
const WRITE_ROLES  = ['System Admin', 'HR Manager', 'Recruiter'];
const EXPORT_ROLES = ['System Admin', 'HR Manager', 'Finance', 'Compliance Officer'];
// Locking a payroll period is a finance/admin action — the data is
// payroll-grade after this, so only Finance + System Admin can lock
// or unlock.
const LOCK_ROLES   = ['System Admin', 'Finance', 'HR Manager'];

@ApiTags('Attendance')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  // GET /attendance/employees — list employees with attendance stats
  @Get('employees')
  @Roles(...READ_ROLES)
  @RequirePermission('attendance:read')
  @ApiOperation({ summary: 'List employees with attendance statistics' })
  listEmployees(@Query() dto: FilterAttendanceEmployeesDto, @CurrentUser() user: any) {
    return this.attendanceService.listEmployeesWithStats(dto, user);
  }

  // GET /attendance/export/excel — Excel export
  @Get('export/excel')
  @Roles(...EXPORT_ROLES)
  @RequirePermission('attendance:read')
  @ApiOperation({ summary: 'Export attendance data as Excel workbook' })
  async exportExcel(
    @Query() dto: ExportAttendanceDto,
    @Res() res: Response,
    @CurrentUser() user: any,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const buffer    = await this.attendanceService.exportExcel(dto, resolveAcceptLanguage(acceptLanguage), user);
    const monthPad  = String(dto.month).padStart(2, '0');
    const filename  = dto.employeeId
      ? `attendance-driver-${dto.year}-${monthPad}.xlsx`
      : `attendance-all-${dto.year}-${monthPad}.xlsx`;

    res.set({
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      buffer.length,
    });
    res.end(buffer);
  }

  // GET /attendance/employees/:employeeId — employee attendance detail
  @Get('employees/:employeeId')
  @Roles(...READ_ROLES)
  @RequirePermission('attendance:read')
  @ApiOperation({ summary: 'Get attendance records for a specific employee' })
  getEmployeeAttendance(
    @Param('employeeId') employeeId: string,
    @Query() dto: GetEmployeeAttendanceDto,
    @CurrentUser() user: any,
  ) {
    return this.attendanceService.getEmployeeAttendance(employeeId, dto, user);
  }

  // POST /attendance — upsert single record
  @Post()
  @Roles(...WRITE_ROLES)
  @RequirePermission('attendance:create')
  @ApiOperation({ summary: 'Create or update an attendance record (upsert by employee + date)' })
  upsert(@Body() dto: UpsertAttendanceDto, @Request() req: any) {
    return this.attendanceService.upsertRecord(dto, req.user?.id);
  }

  // POST /attendance/bulk — bulk upsert (raw list of rows)
  @Post('bulk')
  @Roles(...WRITE_ROLES)
  @RequirePermission('attendance:create')
  @ApiOperation({ summary: 'Bulk upsert attendance records' })
  bulkUpsert(@Body() dto: BulkUpsertAttendanceDto, @Request() req: any) {
    return this.attendanceService.bulkUpsert(dto, req.user?.id);
  }

  // POST /attendance/bulk-apply — apply one template (status +
  // optional times) to a date range or explicit date list.
  @Post('bulk-apply')
  @Roles(...WRITE_ROLES)
  @RequirePermission('attendance:create')
  @ApiOperation({ summary: 'Apply one status + time template to many dates for a single employee' })
  bulkApply(@Body() dto: BulkApplyAttendanceDto, @Request() req: any) {
    return this.attendanceService.bulkApply(dto, req.user?.id);
  }

  // ── Payroll lock management ────────────────────────────────────────────────

  @Get('locked-periods')
  @Roles(...READ_ROLES)
  @RequirePermission('attendance:read')
  @ApiOperation({ summary: 'List all locked payroll periods (year/month)' })
  listLockedPeriods() {
    return this.attendanceService.listLockedPeriods();
  }

  @Post('locked-periods')
  @Roles(...LOCK_ROLES)
  @RequirePermission('attendance:create')
  @ApiOperation({ summary: 'Lock a (year, month) so attendance records in it cannot be edited' })
  lockPeriod(@Body() dto: LockPeriodDto, @Request() req: any) {
    return this.attendanceService.lockPeriod(dto, req.user?.id);
  }

  @Delete('locked-periods/:id')
  @Roles(...LOCK_ROLES)
  @RequirePermission('attendance:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlock a previously-locked payroll period' })
  unlockPeriod(@Param('id') id: string, @Request() req: any) {
    return this.attendanceService.unlockPeriod(id, req.user?.id);
  }

  // PATCH /attendance/:id — update a record
  @Patch(':id')
  @Roles(...WRITE_ROLES)
  @RequirePermission('attendance:update')
  @ApiOperation({ summary: 'Update an existing attendance record by ID' })
  update(@Param('id') id: string, @Body() dto: UpdateAttendanceDto, @Request() req: any) {
    return this.attendanceService.updateRecord(id, dto, req.user?.id, req.user);
  }

  // DELETE /attendance/:id/attachments/:documentId — remove one proof file
  @Delete(':id/attachments/:documentId')
  @Roles(...WRITE_ROLES)
  @RequirePermission('attendance:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete one proof attachment from an attendance record' })
  removeAttachment(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Request() req: any,
  ) {
    return this.attendanceService.deleteAttachment(id, documentId, req.user?.id, req.user);
  }

  // DELETE /attendance/:id — delete a record
  @Delete(':id')
  @Roles(...WRITE_ROLES)
  @RequirePermission('attendance:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an attendance record by ID' })
  remove(@Param('id') id: string, @Request() req: any) {
    return this.attendanceService.deleteRecord(id, req.user?.id, req.user);
  }

  // POST /attendance/:id/clear — softer alternative for roles that hold
  // attendance:update but not attendance:delete. Performs the same
  // row-removal operation (the data is recreatable on next entry), so
  // operators can wipe a mis-entered day without holding full delete
  // privilege.
  @Post(':id/clear')
  @Roles(...WRITE_ROLES)
  @RequirePermission('attendance:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear an attendance record by ID — same effect as delete, but available to update-only roles.' })
  clear(@Param('id') id: string, @Request() req: any) {
    return this.attendanceService.deleteRecord(id, req.user?.id, req.user);
  }

  // DELETE /attendance/employees/:employeeId/month/:year/:month
  //   — reset every attendance record for one employee in one month
  @Delete('employees/:employeeId/month/:year/:month')
  @Roles(...WRITE_ROLES)
  @RequirePermission('attendance:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset (hard-delete) every attendance record for one employee in one month' })
  resetEmployeeMonth(
    @Param('employeeId') employeeId: string,
    @Param('year') year: string,
    @Param('month') month: string,
    @Request() req: any,
  ) {
    return this.attendanceService.resetEmployeeMonth(
      employeeId,
      Number(year),
      Number(month),
      req.user,
      req.user?.id,
    );
  }
}
