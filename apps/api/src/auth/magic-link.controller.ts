import {
  Body,
  Controller,
  Get,
  Head,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import type { ApiEnvironment } from '../config/environment.js';
import {
  PORTAL_SESSION_COOKIE,
  readPortalCookie,
  setPortalSessionCookies,
} from '../identity/portal-session.service.js';
import { MAGIC_LINK_ENVIRONMENT, MagicLinkService } from './magic-link.service.js';

class MagicLinkRequestBody {
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

class MagicLinkConsumeBody {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  linkToken!: string;
}

type MagicLinkRequest = Request & { requestId?: string };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

@Controller('auth/magic-links')
export class MagicLinkController {
  constructor(
    private readonly magicLinks: MagicLinkService,
    @Inject(MAGIC_LINK_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  @Post()
  @HttpCode(202)
  @PublicRoute()
  async requestLink(
    @Body() body: MagicLinkRequestBody,
    @Req() request: MagicLinkRequest,
  ): Promise<{ readonly accepted: true; readonly requestId: string }> {
    await this.magicLinks.request(body.email, request.ip);
    return Object.freeze({ accepted: true, requestId: request.requestId ?? 'unknown' });
  }

  @Get('confirm')
  @PublicRoute()
  confirmationPage(@Query('token') token: string | undefined, @Res() response: Response): void {
    // GET is deliberately presentation-only. No token lookup, attempt count, or session write occurs here.
    const safeToken = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
    const nonce = randomBytes(18).toString('base64');
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Confirm portal sign-in</title><script nonce="${nonce}">history.replaceState(null, '', location.pathname)</script></head><body><main><h1>Confirm sign-in</h1><p id="message" aria-live="polite">Continue only if you requested this portal link.</p><form id="confirmation" method="post" action="/api/v1/auth/magic-links/consume"><input type="hidden" name="linkToken" value="${escapeHtml(safeToken)}"><button type="submit">Continue to the portal</button></form><section id="tenant-options" hidden><h2>Choose a business</h2></section></main><script nonce="${nonce}">
      const form = document.getElementById('confirmation');
      const message = document.getElementById('message');
      const choices = document.getElementById('tenant-options');
      const submitButton = form.querySelector('button');
      function readCookie(name) {
        const prefix = name + '=';
        const item = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
        return item ? item.slice(prefix.length) : '';
      }
      async function chooseTenant(option, currentTenant) {
        if (option.tenantRef !== currentTenant) {
          const switched = await fetch('/api/v1/session/tenant-switch', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': readCookie('__Host-ca_meta_csrf'),
              'X-Tenant-Context': readCookie('__Host-ca_meta_context'),
            },
            body: JSON.stringify({ tenantRef: option.tenantRef }),
          });
          if (!switched.ok) {
            message.textContent = 'That business is no longer available. Refresh your session and choose again.';
            return;
          }
        }
        window.location.replace('/');
      }
      form.addEventListener('submit', async event => {
        event.preventDefault();
        submitButton.disabled = true;
        message.textContent = 'Signing you in…';
        try {
          const response = await fetch(form.action, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ linkToken: form.elements.linkToken.value }),
          });
          if (!response.ok) {
            message.textContent = 'This link is no longer available. Request a new sign-in link.';
            submitButton.disabled = false;
            return;
          }
          const result = await response.json();
          message.textContent = 'Choose the business you want to open.';
          choices.replaceChildren();
          for (const option of result.availableTenants) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = option.tenantRef;
            button.addEventListener('click', () => void chooseTenant(option, result.tenantRef));
            choices.append(button);
          }
          choices.hidden = false;
          if (result.availableTenants.length === 1) {
            await chooseTenant(result.availableTenants[0], result.tenantRef);
          }
        } catch {
          message.textContent = 'Sign-in could not be completed. Return to the portal and check your session.';
          submitButton.disabled = false;
        }
      });
    </script></body></html>`;
    response.status(200)
      .type('html')
      .setHeader('Referrer-Policy', 'no-referrer')
      .setHeader('Cache-Control', 'no-store')
      .setHeader('X-Robots-Tag', 'noindex, nofollow')
      .setHeader('Content-Security-Policy', `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; script-src 'nonce-${nonce}'`)
      .send(page);
  }

  @Head('confirm')
  @PublicRoute()
  confirmationHead(@Res() response: Response): void {
    response.status(200)
      .type('html')
      .setHeader('Referrer-Policy', 'no-referrer')
      .setHeader('Cache-Control', 'no-store')
      .setHeader('X-Robots-Tag', 'noindex, nofollow')
      .setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
      .end();
  }

  @Post('consume')
  @HttpCode(201)
  @PublicRoute()
  async consume(
    @Body() body: MagicLinkConsumeBody,
    @Req() request: MagicLinkRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{
    readonly sessionRef: string;
    readonly principalRef: string;
    readonly tenantRef: string;
    readonly roles: readonly string[];
    readonly tenantContextRef: string;
    readonly contextVersion: number;
    readonly availableTenants: readonly { readonly tenantRef: string; readonly roles: readonly string[] }[];
    readonly requestId: string;
  } | void> {
    const result = await this.magicLinks.consume(
      body.linkToken,
      request.ip,
      readPortalCookie(request.headers.cookie, PORTAL_SESSION_COOKIE),
    );
    setPortalSessionCookies(response, result.session);
    const bodyResult = Object.freeze({
      sessionRef: result.session.publicContext.sessionRef,
      principalRef: result.session.publicContext.principalRef,
      tenantRef: result.session.publicContext.tenantRef,
      roles: result.session.publicContext.roles,
      tenantContextRef: result.session.publicContext.tenantContextRef,
      contextVersion: result.session.publicContext.contextVersion,
      availableTenants: Object.freeze(result.availableTenants.map((option) => Object.freeze({
        tenantRef: option.tenantRef,
        roles: Object.freeze([...option.roles]),
      }))),
      requestId: request.requestId ?? 'unknown',
    });
    const accept = request.headers.accept ?? '';
    if (typeof accept === 'string' && accept.includes('text/html')) {
      response.redirect(303, this.magicLinks.getConfirmationOrigin());
      return;
    }
    return bodyResult;
  }

  @Get('local-inbox')
  @PublicRoute()
  localInbox(@Req() request: MagicLinkRequest): { readonly messages: ReturnType<MagicLinkService['localInboxMessages']> } {
    const localRuntime = this.environment.nodeEnv === 'development' || this.environment.nodeEnv === 'test';
    const localBinding = isLoopbackAddress(this.environment.bindAddress) && this.environment.trustedProxyCidrs === false;
    if (!localRuntime || !localBinding || !isLoopbackAddress(request.ip)) throw new NotFoundException();
    return Object.freeze({ messages: this.magicLinks.localInboxMessages() });
  }
}
