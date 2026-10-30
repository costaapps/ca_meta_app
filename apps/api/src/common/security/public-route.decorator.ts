import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE_KEY = 'api.public-route';

export const PublicRoute = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE_KEY, true);
