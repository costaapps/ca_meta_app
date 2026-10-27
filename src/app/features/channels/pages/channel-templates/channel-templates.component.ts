import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { ConnectedChannel } from '../../../../core/models/channel.model';
import { MetaIntegrationService } from '../../../../core/services/meta-integration.service';
import { WhatsAppTemplate } from '../../../../core/models/channel.model';

@Component({
  selector: 'app-channel-templates',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './channel-templates.component.html',
  styleUrls: ['./channel-templates.component.scss']
})
export class ChannelTemplatesComponent implements OnInit, OnDestroy {
  whatsAppNumbers: ConnectedChannel[] = [];
  templates: WhatsAppTemplate[] = [];
  selectedNumberId = '';

  isLoadingNumbers = true;
  isLoadingTemplates = false;
  isCreating = false;

  successMessage = '';
  errorMessage = '';

  createForm = {
    name: '',
    category: 'MARKETING',
    body: '',
    language: 'pt_BR'
  };

  variableExamples: string[] = [];

  private destroy$ = new Subject<void>();

  constructor(private metaService: MetaIntegrationService) {}

  ngOnInit(): void {
    this.metaService
      .getConnectedChannels()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (channels) => {
          this.whatsAppNumbers = channels.filter((channel) => channel.type === 'WHATSAPP');
          this.isLoadingNumbers = false;

          if (this.whatsAppNumbers.length === 1) {
            this.selectedNumberId = this.whatsAppNumbers[0].externalId;
            this.loadTemplates();
          }
        },
        error: (error) => {
          console.error('Failed to load WhatsApp numbers:', error);
          this.errorMessage = 'Failed to load WhatsApp numbers.';
          this.isLoadingNumbers = false;
        }
      });
  }

  onSelectNumber(): void {
    this.templates = [];
    this.successMessage = '';
    this.errorMessage = '';

    if (!this.selectedNumberId) {
      return;
    }

    this.loadTemplates();
  }

  loadTemplates(): void {
    if (!this.selectedNumberId) {
      return;
    }

    this.isLoadingTemplates = true;
    this.errorMessage = '';

    this.metaService
      .getWhatsAppTemplates(this.selectedNumberId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (templates) => {
          this.templates = templates;
          this.isLoadingTemplates = false;
        },
        error: (error) => {
          console.error('Failed to load templates:', error);
          this.errorMessage = 'Failed to load templates.';
          this.isLoadingTemplates = false;
        }
      });
  }

  createTemplate(): void {
    this.successMessage = '';
    this.errorMessage = '';

    if (!this.selectedNumberId) {
      this.errorMessage = 'Select a WhatsApp number first.';
      return;
    }

    if (!this.createForm.name.trim() || !this.createForm.body.trim()) {
      this.errorMessage = 'Template name and body are required.';
      return;
    }

    const placeholders = this.getCreatePlaceholders();
    if (placeholders.length > 0) {
      if (this.variableExamples.length < placeholders.length) {
        this.errorMessage = 'Add example values for all placeholders.';
        return;
      }

      if (this.variableExamples.slice(0, placeholders.length).some((value) => !value.trim())) {
        this.errorMessage = 'Fill all placeholder example values.';
        return;
      }
    }

    this.isCreating = true;

    this.metaService
      .createWhatsAppTemplate({
        phoneNumberId: this.selectedNumberId,
        name: this.createForm.name.trim(),
        category: this.createForm.category,
        body: this.createForm.body.trim(),
        language: this.createForm.language,
        exampleValues: placeholders.length
          ? this.variableExamples.slice(0, placeholders.length).map((value) => value.trim())
          : []
      })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.isCreating = false;
          this.successMessage = 'Template created successfully.';
          this.createForm.body = '';
          this.variableExamples = [];
          this.loadTemplates();
        },
        error: (error) => {
          console.error('Failed to create template:', error);
          this.errorMessage = 'Failed to create template.';
          this.isCreating = false;
        }
      });
  }

  trackTemplateByName(_: number, template: WhatsAppTemplate): string {
    return template.name;
  }

  getTemplateBody(template: WhatsAppTemplate): string {
    const bodyComponent = template.components?.find((component) => component.type === 'BODY');
    return bodyComponent?.text || '';
  }

  getTemplatePlaceholders(template: WhatsAppTemplate): string[] {
    const bodyText = this.getTemplateBody(template);
    if (!bodyText) {
      return [];
    }

    const matches = bodyText.match(/\{\{\d+\}\}/g) || [];
    const unique = Array.from(new Set(matches));
    unique.sort((a, b) => {
      const aNum = parseInt(a.replace(/\D/g, ''), 10);
      const bNum = parseInt(b.replace(/\D/g, ''), 10);
      return aNum - bNum;
    });
    return unique;
  }

  addVariable(): void {
    this.variableExamples.push('');
    const placeholder = `{{${this.variableExamples.length}}}`;
    if (!this.createForm.body.includes(placeholder)) {
      this.createForm.body = `${this.createForm.body.trim()} ${placeholder}`.trim();
    }
  }

  insertPlaceholder(index: number): void {
    const placeholder = `{{${index + 1}}}`;
    if (!this.createForm.body.includes(placeholder)) {
      this.createForm.body = `${this.createForm.body.trim()} ${placeholder}`.trim();
    }
  }

  getCreatePlaceholders(): string[] {
    const bodyText = this.createForm.body;
    if (!bodyText) {
      return [];
    }

    const matches = bodyText.match(/\{\{\d+\}\}/g) || [];
    const unique = Array.from(new Set(matches));
    unique.sort((a, b) => {
      const aNum = parseInt(a.replace(/\D/g, ''), 10);
      const bNum = parseInt(b.replace(/\D/g, ''), 10);
      return aNum - bNum;
    });
    return unique;
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
