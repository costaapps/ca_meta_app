import { DynamicModule, Module } from '@nestjs/common';
import { WhatsAppExclusiveOnboardingAdapter, type WhatsAppExclusiveOperations } from './whatsapp-exclusive-onboarding.adapter.js';

export const WHATSAPP_EXCLUSIVE_OPERATIONS = Symbol('WHATSAPP_EXCLUSIVE_OPERATIONS');

/** Separate module surface for the exclusive flow; shared onboarding wiring remains a coordinator decision. */
@Module({})
export class WhatsAppExclusiveOnboardingModule {
  static register(operations: WhatsAppExclusiveOperations): DynamicModule {
    return {
      module: WhatsAppExclusiveOnboardingModule,
      providers: [
        { provide: WHATSAPP_EXCLUSIVE_OPERATIONS, useValue: operations },
        {
          provide: WhatsAppExclusiveOnboardingAdapter,
          useFactory: (value: WhatsAppExclusiveOperations) => new WhatsAppExclusiveOnboardingAdapter(value),
          inject: [WHATSAPP_EXCLUSIVE_OPERATIONS],
        },
      ],
      exports: [WhatsAppExclusiveOnboardingAdapter],
    };
  }
}
