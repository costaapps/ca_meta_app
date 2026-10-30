export class CredentialVaultError extends Error {
  constructor(readonly code: string) {
    super('Credential vault operation could not be completed.');
    this.name = 'CredentialVaultError';
  }
}

export class CredentialVaultDeniedError extends CredentialVaultError {
  constructor() { super('CREDENTIAL_VAULT_DENIED'); this.name = 'CredentialVaultDeniedError'; }
}

export class CredentialVaultKeyUnavailableError extends CredentialVaultError {
  constructor() { super('CREDENTIAL_KEY_UNAVAILABLE'); this.name = 'CredentialVaultKeyUnavailableError'; }
}

export class CredentialVaultIntegrityError extends CredentialVaultError {
  constructor() { super('CREDENTIAL_CIPHERTEXT_INVALID'); this.name = 'CredentialVaultIntegrityError'; }
}

export class CredentialVaultOperationError extends CredentialVaultError {
  constructor() { super('CREDENTIAL_VAULT_OPERATION_FAILED'); this.name = 'CredentialVaultOperationError'; }
}

export class CredentialVaultRecordUnavailableError extends CredentialVaultError {
  constructor() { super('CREDENTIAL_UNAVAILABLE'); this.name = 'CredentialVaultRecordUnavailableError'; }
}

export class CredentialVaultRotationBusyError extends CredentialVaultError {
  constructor() { super('CREDENTIAL_ROTATION_BUSY'); this.name = 'CredentialVaultRotationBusyError'; }
}

export class CredentialVaultRotationError extends CredentialVaultError {
  constructor() { super('CREDENTIAL_ROTATION_FAILED'); this.name = 'CredentialVaultRotationError'; }
}
