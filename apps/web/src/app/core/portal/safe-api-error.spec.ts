import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { safeRequestId } from './safe-api-error';

describe('safeRequestId', () => {
  it('uses a bounded safe request id from the response header or envelope', () => {
    const headerError = new HttpErrorResponse({
      status: 503,
      headers: new HttpHeaders({ 'X-Request-Id': 'req-safe-123' }),
      error: { token: 'never-render' },
    });
    const bodyError = new HttpErrorResponse({ status: 409, error: { requestId: 'req-context-123' } });

    expect(safeRequestId(headerError)).toBe('req-safe-123');
    expect(safeRequestId(bodyError)).toBe('req-context-123');
  });

  it('never returns raw backend content or malformed identifiers', () => {
    expect(safeRequestId(new HttpErrorResponse({ status: 500, error: { requestId: '<script>token</script>' } }))).toBeNull();
    expect(safeRequestId(new Error('raw backend token'))).toBeNull();
  });
});
