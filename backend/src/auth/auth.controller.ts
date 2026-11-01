import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Req,
  Param,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LoginV2Dto } from './dto/login-v2.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private jwtService: JwtService,
  ) {}

  // ---------------------------------------------------------------------------
  // Login — now accepts optional agencyId
  // ---------------------------------------------------------------------------
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Returns JWT tokens and user info' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  login(@Body() loginDto: LoginDto & { agencyId?: string; company?: string }, @Req() req: any) {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    // Phase 3.13 — when TENANT_LOGIN_REQUIRED=true the legacy endpoint
    // requires `company` and routes to the tenant-aware path so frontends
    // can migrate without dual-endpoint coordination.
    // @tenant-reviewed: phase313-tenant-aware-login
    if (process.env.TENANT_LOGIN_REQUIRED === 'true') {
      if (!loginDto?.company || !loginDto.email || !loginDto.password) {
        throw new UnauthorizedException({
          code: 'AUTH.INVALID_CREDENTIALS',
          message: 'Invalid company, email, or password',
        });
      }
      return this.authService.loginV2(
        { company: loginDto.company, email: loginDto.email, password: loginDto.password },
        ip,
      );
    }
    return this.authService.login(loginDto, ip);
  }

  // Phase 3.13 — tenant-aware login. ALWAYS requires `company`, regardless
  // of TENANT_LOGIN_REQUIRED. @tenant-reviewed: phase313-tenant-aware-login
  @Public()
  @Post('login-v2')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with company, email, and password (tenant-aware)' })
  @ApiResponse({ status: 200, description: 'Returns JWT tokens and user info' })
  @ApiResponse({ status: 401, description: 'Invalid company, email, or password' })
  loginV2(@Body() loginDto: LoginV2Dto, @Req() req: any) {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    return this.authService.loginV2(loginDto, ip);
  }

  // Phase 3.17 — re-issue a JWT bound to a different tenant the user
  // has an ACTIVE membership in. Requires a valid current session.
  // @tenant-reviewed: phase317-multi-tenant-login
  @Post('switch-tenant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Switch the active tenant for the current session' })
  @ApiResponse({ status: 200, description: 'New access + refresh tokens bound to the target tenant' })
  switchTenant(@Body() body: { tenantId: string }, @Req() req: any) {
    const userId = req?.user?.id ?? req?.user?.sub;
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    return this.authService.switchTenant(userId, body.tenantId, ip);
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout current user' })
  logout(@CurrentUser('id') userId: string, @Req() req: any) {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    // The JWT carries the tenant the session was opened against; pass it
    // through so the LOGOUT audit row scopes to the same tenant that the
    // matching LOGIN row used — otherwise rint-solutions sessions
    // were recorded against the user's primary (tempworks) tenant.
    return this.authService.logout(userId, ip, req.user?.tenantId ?? null);
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  async refresh(@Body() dto: RefreshTokenDto) {
    const decoded = this.jwtService.decode(dto.refreshToken) as any;
    if (!decoded?.sub) throw new UnauthorizedException({ code: 'AUTH.INVALID_REFRESH_TOKEN', message: 'Invalid refresh token' });
    return this.authService.refreshTokens(decoded.sub, dto.refreshToken);
  }

  // ---------------------------------------------------------------------------
  // Get current user
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  getMe(@CurrentUser() caller: any) {
    // Phase 3.17 — pass the JWT-stamped tenantId so /auth/me can mark
    // which membership is currently active in the topbar switcher.
    return this.authService.getMe(caller?.id, { activeTenantId: caller?.tenantId });
  }

  // ---------------------------------------------------------------------------
  // Change password
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change current user password' })
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
    @Req() req: any,
  ) {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    return this.authService.changePassword(userId, dto.currentPassword, dto.newPassword, ip);
  }

  // ---------------------------------------------------------------------------
  // Two-factor authentication
  // ---------------------------------------------------------------------------
  @Public()
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete login by submitting the emailed 2FA code' })
  verifyTwoFactor(
    @Body() dto: { challengeId: string; code: string },
    @Req() req: any,
  ) {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    return this.authService.verifyTwoFactor(dto.challengeId, dto.code, ip);
  }

  @Public()
  @Post('2fa/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-send the 2FA code for an existing challenge' })
  resendTwoFactor(@Body() dto: { challengeId: string }, @Req() req: any) {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    return this.authService.resendTwoFactor(dto.challengeId, ip);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Enable email-based two-factor authentication for the current user' })
  enableTwoFactor(@CurrentUser('id') userId: string, @Req() req: any) {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    return this.authService.setTwoFactorEnabled(userId, true, ip);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disable two-factor authentication for the current user' })
  disableTwoFactor(@CurrentUser('id') userId: string, @Req() req: any) {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    return this.authService.setTwoFactorEnabled(userId, false, ip);
  }

  // ---------------------------------------------------------------------------
  // Activate account
  // ---------------------------------------------------------------------------
  @Public()
  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate account using email token and set password' })
  @ApiResponse({ status: 200, description: 'Account activated, returns JWT tokens' })
  @ApiResponse({ status: 400, description: 'Invalid or expired activation token' })
  activateAccount(@Body() dto: { token: string; password: string }) {
    return this.authService.activateAccount(dto.token, dto.password);
  }

  // ---------------------------------------------------------------------------
  // Forgot password (user-initiated)
  // ---------------------------------------------------------------------------
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset email' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  // ---------------------------------------------------------------------------
  // Reset password (apply new password from token)
  // ---------------------------------------------------------------------------
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using email token' })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired reset token' })
  resetPassword(@Body() dto: { token: string; newPassword: string }, @Req() req: any) {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    return this.authService.resetPassword(dto.token, dto.newPassword, ip);
  }

  // ---------------------------------------------------------------------------
  // Admin: trigger password reset for a specific user
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard)
  @Post('admin/reset-password/:userId')
  @HttpCode(HttpStatus.OK)
  @Roles('System Admin', 'HR Manager')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin-initiated password reset for a user' })
  async adminResetPassword(
    @Param('userId') userId: string,
    @CurrentUser('id') actorId: string,
  ) {
    await this.authService.adminResetPassword(userId, actorId);
    return { message: 'Password reset email sent successfully' };
  }

  // ---------------------------------------------------------------------------
  // Admin: resend activation email to a user
  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard)
  @Post('resend-activation/:userId')
  @HttpCode(HttpStatus.OK)
  @Roles('System Admin', 'HR Manager')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resend activation email to a PENDING/INACTIVE user' })
  async resendActivation(
    @Param('userId') userId: string,
    @CurrentUser('id') actorId: string,
  ) {
    await this.authService.resendActivation(userId, actorId);
    return { message: 'Activation email resent successfully' };
  }
}
