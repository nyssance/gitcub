/** Serializable X.509 details for an explicit certificate-trust prompt. */
export interface CertificatePrincipal {
  commonName: string
  organizations: string[]
  organizationUnits: string[]
  locality: string
  state: string
  country: string
}
export interface Certificate {
  data: string
  issuer: CertificatePrincipal
  issuerName: string
  issuerCert?: Certificate
  subject: CertificatePrincipal
  subjectName: string
  serialNumber: string
  validStart: number
  validExpiry: number
  fingerprint: string
}
