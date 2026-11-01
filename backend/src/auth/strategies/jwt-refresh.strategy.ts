import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromBodyField('refreshToken'),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_REFRESH_SECRET || 'default-refresh-secret-change-in-prod',
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: any) {
    const refreshToken = req.body?.refreshToken;
    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: { id: true, status: true, refreshToken: true },
    });
    if (!user || !user.refreshToken) {
      throw new UnauthorizedException({ code: 'AUTH.ACCESS_DENIED', message: 'Access denied' });
    }
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'AUTH.ACCOUNT_STATUS',
        message: `Account is ${user.status.toLowerCase()}`,
        params: { status: user.status.toLowerCase() },
      });
    }
    return { ...payload, refreshToken };
  }
}
