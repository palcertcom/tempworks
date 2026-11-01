import {
  Controller, Get, Post, Body, Patch, Param, Delete,
  Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
  ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam,
} from '@nestjs/swagger';
import { JobAdsService } from './job-ads.service';
import { CreateJobAdDto } from './dto/create-job-ad.dto';
import { UpdateJobAdDto } from './dto/update-job-ad.dto';
import { FilterJobAdsDto } from './dto/filter-job-ads.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import {
  JOB_ADS_READ_ROLES, JOB_ADS_WRITE_ROLES,
  JOB_AD_STATUSES, CONTRACT_TYPES, JOB_CATEGORIES, COMMON_CURRENCIES,
} from './constants';

// ── Public endpoints (no auth) ────────────────────────────────────────────────

@ApiTags('Job Ads – Public')
@Controller('public/jobs')
export class PublicJobAdsController {
  constructor(private readonly jobAdsService: JobAdsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List published job ads (public, no auth). Pass ?tenant=<slug-or-domain> to scope to a single tenant.' })
  findPublished(@Query() filter: FilterJobAdsDto, @Query('tenant') tenant?: string) {
    return this.jobAdsService.findPublished(filter, tenant);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Get a single published job ad by slug (public, no auth)' })
  @ApiParam({ name: 'slug', description: 'URL-friendly slug' })
  findBySlug(@Param('slug') slug: string, @Query('tenant') tenant?: string) {
    return this.jobAdsService.findBySlug(slug, tenant);
  }
}

// ── Tenant-scoped public endpoints ────────────────────────────────────────────
// Mirrors /public/jobs but scopes by an explicit tenant slug or
// customDomain in the URL so each tenant gets its own clean "Current
// Job Openings" page (/t/:tenant/jobs).
// @tenant-reviewed: phase318-tenant-public-jobs
@ApiTags('Job Ads – Public (tenant-scoped)')
@Controller('public/tenants/:tenant/jobs')
export class PublicTenantJobAdsController {
  constructor(private readonly jobAdsService: JobAdsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List published job ads for the named tenant' })
  findPublished(@Param('tenant') tenant: string, @Query() filter: FilterJobAdsDto) {
    return this.jobAdsService.findPublished(filter, tenant);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Get a single published job ad by slug, scoped to the named tenant' })
  findBySlug(@Param('tenant') tenant: string, @Param('slug') slug: string) {
    return this.jobAdsService.findBySlug(slug, tenant);
  }
}

// ── Dashboard / authenticated endpoints ──────────────────────────────────────

@ApiTags('Job Ads')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('job-ads')
export class JobAdsController {
  constructor(private readonly jobAdsService: JobAdsService) {}

  // ── Constants ──────────────────────────────────────────────────────────────

  @Get('constants')
  @Roles(...JOB_ADS_READ_ROLES)
  @RequirePermission('job-ads:read')
  @ApiOperation({ summary: 'Get job-ads module constants (statuses, categories, contract types, currencies)' })
  getConstants() {
    return {
      statuses:      JOB_AD_STATUSES,
      contractTypes: CONTRACT_TYPES,
      categories:    JOB_CATEGORIES,
      currencies:    COMMON_CURRENCIES,
    };
  }

  // ── List ───────────────────────────────────────────────────────────────────

  @Get()
  @Roles(...JOB_ADS_READ_ROLES)
  @RequirePermission('job-ads:read')
  @ApiOperation({ summary: 'List job ads (paginated + filtered, dashboard) — scoped to the caller\'s active tenant' })
  findAll(@Query() filter: FilterJobAdsDto, @CurrentUser() user: any) {
    return this.jobAdsService.findAll(filter, user);
  }

  // ── Single ─────────────────────────────────────────────────────────────────

  @Get(':id')
  @Roles(...JOB_ADS_READ_ROLES)
  @RequirePermission('job-ads:read')
  @ApiOperation({ summary: 'Get a single job ad by ID' })
  @ApiParam({ name: 'id', description: 'Job ad UUID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.jobAdsService.findOne(id, user);
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  @Post()
  @Roles(...JOB_ADS_WRITE_ROLES)
  @RequirePermission('job-ads:create')
  @ApiOperation({ summary: 'Create a job ad' })
  @ApiResponse({ status: 201, description: 'Job ad created' })
  create(@Body() dto: CreateJobAdDto, @CurrentUser() user: any) {
    return this.jobAdsService.create(dto, user?.id, user);
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  @Patch(':id')
  @Roles(...JOB_ADS_WRITE_ROLES)
  @RequirePermission('job-ads:update')
  @ApiOperation({ summary: 'Update a job ad (partial)' })
  @ApiParam({ name: 'id', description: 'Job ad UUID' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateJobAdDto,
    @CurrentUser() user: any,
  ) {
    return this.jobAdsService.update(id, dto, user?.id, user);
  }

  // ── Soft-delete ────────────────────────────────────────────────────────────

  @Delete(':id')
  @Roles(...JOB_ADS_WRITE_ROLES)
  @RequirePermission('job-ads:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a job ad' })
  @ApiParam({ name: 'id', description: 'Job ad UUID' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.jobAdsService.remove(id, user);
  }
}
