import {
  Controller, Get, Patch, Post, Put, Delete, Param, Body, UseGuards, Request, Query, Headers,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { resolveAcceptLanguage } from '../common/i18n/server-translate';
import { NOTIF_EVENT_META } from './notification-events';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async getNotifications(
    @Request() req: any,
    @Query('skip') skip = '0',
    @Query('take') take = '20',
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('tenantId') tenantIdQuery?: string,
    @Query('isRead') isReadQ?: string,
    @Query('type') typeQ?: string,
    @Query('eventType') eventTypeQ?: string,
    @Query('category') categoryQ?: string,
    @Query('channel') channelQ?: string,
    @Query('priority') priorityQ?: string,
    @Query('relatedPerson') relatedPersonQ?: string,
    @Query('sortBy') sortByQ?: string,
    @Query('search') searchQ?: string,
    @Query('dateFrom') dateFromQ?: string,
    @Query('dateTo') dateToQ?: string,
    @Query('sortOrder') sortOrderQ?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const locale = resolveAcceptLanguage(acceptLanguage);
    const caller = { agencyId: req.user?.agencyId, agencyIsSystem: req.user?.agencyIsSystem, tenantId: req.user?.tenantId, role: req.user?.role };

    // Frontend may send either `skip/take` or `page/limit`. Resolve to
    // the canonical skip/take pair the service expects.
    const limitN = limit ? parseInt(limit) : parseInt(take);
    const pageN  = page  ? Math.max(1, parseInt(page)) : null;
    const skipN  = pageN ? (pageN - 1) * limitN : parseInt(skip);

    const isRead = isReadQ === undefined || isReadQ === ''
      ? undefined
      : (isReadQ === 'true' || isReadQ === '1');
    const filters = {
      isRead,
      type: typeQ || undefined,
      eventType: eventTypeQ || undefined,
      category: categoryQ || undefined,
      channel: channelQ || undefined,
      priority: priorityQ || undefined,
      relatedPerson: relatedPersonQ || undefined,
      search: searchQ || undefined,
      dateFrom: dateFromQ || undefined,
      dateTo: dateToQ || undefined,
      sortBy: (sortByQ === 'priority' ? 'priority' : 'createdAt') as 'createdAt' | 'priority',
      sortOrder: (sortOrderQ === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc',
    };

    return this.notificationsService.getUserNotifications(
      req.user.id, skipN, limitN, locale, caller, tenantIdQuery, filters,
    );
  }

  /**
   * Public catalogue of notification events. Returns the registry
   * meta only — no per-user data — so the NotificationCenter and
   * settings UIs can render event labels / category groupings without
   * each maintaining a hardcoded copy of the event list.
   *
   * Cacheable for the UI session; the catalogue only changes on a
   * backend deploy.
   */
  @Get('meta')
  async getMeta() {
    return { meta: NOTIF_EVENT_META };
  }

  @Get('unread-count')
  async getUnreadCount(@Request() req: any) {
    const caller = { agencyId: req.user?.agencyId, agencyIsSystem: req.user?.agencyIsSystem, tenantId: req.user?.tenantId, role: req.user?.role };
    const count = await this.notificationsService.getUnreadCount(req.user.id, caller);
    // Both shapes — `count` (new) and `unreadCount` (legacy Topbar
    // poller) — so neither client breaks during a partial deploy.
    return { count, unreadCount: count };
  }

  @Patch(':notificationId/read')
  async markAsRead(@Param('notificationId') notificationId: string) {
    return this.notificationsService.markAsRead(notificationId);
  }

  @Patch(':notificationId/unread')
  async markAsUnread(@Param('notificationId') notificationId: string) {
    return this.notificationsService.markAsUnread(notificationId);
  }

  // mark-all-read: accept both Patch /read-all (legacy) and Post
  // /mark-all-read (current frontend convention) so clients on either
  // URL keep working.
  @Patch('read-all')
  async markAllAsRead(@Request() req: any) {
    await this.notificationsService.markAllAsRead(req.user.id);
    return { success: true };
  }

  @Post('mark-all-read')
  async markAllAsReadPost(@Request() req: any) {
    await this.notificationsService.markAllAsRead(req.user.id);
    return { success: true };
  }

  @Post('bulk-delete')
  async bulkDelete(@Request() req: any, @Body() body: { ids: string[] }) {
    return this.notificationsService.bulkSoftDelete(body?.ids ?? [], req.user.id);
  }

  @Post('bulk-mark-read')
  async bulkMarkRead(@Request() req: any, @Body() body: { ids: string[] }) {
    return this.notificationsService.bulkMarkAsRead(body?.ids ?? [], req.user.id);
  }

  @Post('bulk-mark-unread')
  async bulkMarkUnread(@Request() req: any, @Body() body: { ids: string[] }) {
    return this.notificationsService.bulkMarkAsUnread(body?.ids ?? [], req.user.id);
  }

  @Delete(':notificationId')
  async deleteOne(@Request() req: any, @Param('notificationId') notificationId: string) {
    return this.notificationsService.softDelete(notificationId, req.user.id);
  }

  @Get('preferences')
  async getPreferences(@Request() req: any) {
    return this.notificationsService.getOrCreatePreferences(req.user.id);
  }

  @Patch('preferences')
  async updatePreferences(@Request() req: any, @Body() data: any) {
    return this.notificationsService.updatePreferences(req.user.id, data);
  }

  // Some clients send PUT (frontend api.ts uses PUT for preferences);
  // accept it as an alias to PATCH.
  @Put('preferences')
  async updatePreferencesPut(@Request() req: any, @Body() data: any) {
    return this.notificationsService.updatePreferences(req.user.id, data);
  }
}
