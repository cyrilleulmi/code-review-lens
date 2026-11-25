import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners } from '@angular/core';
import { HttpInterceptorFn, provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { certificateTarget } from './api';
import { ReviewStore } from './review.store';

/**
 * A request that failed on the certificate of a code host (company CA, self-signed …) opens the certificate dialog,
 * wherever it came from (adding a connection, opening a link, reloading): it shows the certificate and offers to trust
 * it. The error still reaches the caller, which shows its message as usual.
 */
const certificateErrors: HttpInterceptorFn = (req, next) => {
  const store = inject(ReviewStore);
  return next(req).pipe(
    catchError((err: unknown) => {
      const target = certificateTarget(err);
      if (target && !req.url.startsWith('/api/tls')) {
        store.certificateFor.set(target);
      }
      return throwError(() => err);
    }),
  );
};

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideHttpClient(withFetch(), withInterceptors([certificateErrors]))],
};
