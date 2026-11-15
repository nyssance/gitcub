/** Serializable certificate details passed to trust/error dialogs. */
export interface NativeCertificate {
  data: string
  issuer: CertificatePrincipal
  issuerName: string
  issuerCert: NativeCertificate
  subject: CertificatePrincipal
  subjectName: string
  serialNumber: string
  validStart: number
  validExpiry: number
  fingerprint: string
}
interface CertificatePrincipal {
  commonName: string
  organizations: string[]
  organizationUnits: string[]
  locality: string
  state: string
  country: string
}
