import type { Claim } from './claim'

/**
 * One worked example, used for the demo and as a fixture in tests.
 *
 * The numbers reconcile deliberately: a ₹2,80,000 final bill against
 * ₹2,73,600 of receipts, leaving ₹6,400 that nothing accounts for. That
 * gap is the thing an insurer reduces a payout over, and the thing this
 * app exists to surface before anyone posts the envelope.
 */
export const demoClaim: Claim = {
  id: 'demo',
  patientName: "Appa's admission",
  hospital: 'Manipal Hospital, Old Airport Road',
  admittedOn: '2026-10-13',
  dischargedOn: '2026-10-19',
  finalBillPaise: 2_80_000_00,
  submissionWindowDays: 30,
  status: 'draft',
  members: [
    { id: 'u1', name: 'Madhura', initials: 'M' },
    { id: 'u2', name: 'Anand', initials: 'A' },
    { id: 'u3', name: 'Shruti', initials: 'S' },
  ],
  items: [
    {
      id: 'i1',
      label: 'Claim form',
      kind: 'record',
      expected: 1,
      required: true,
      docs: [
        {
          id: 'd1',
          name: 'claim-form-signed.pdf',
          amountPaise: null,
          uploadedBy: 'Madhura',
          uploadedAt: '2026-10-21T09:12:00Z',
        },
      ],
    },
    {
      id: 'i2',
      label: 'Payment receipts',
      kind: 'bill',
      expected: 2,
      required: true,
      docs: [
        {
          id: 'd2',
          name: 'hospital-receipt-1.jpg',
          amountPaise: 1_90_400_00,
          uploadedBy: 'Anand',
          uploadedAt: '2026-10-21T09:40:00Z',
        },
        {
          id: 'd3',
          name: 'hospital-receipt-2.jpg',
          amountPaise: 56_500_00,
          uploadedBy: 'Anand',
          uploadedAt: '2026-10-21T09:41:00Z',
        },
      ],
    },
    {
      id: 'i3',
      label: 'Itemised bill',
      kind: 'record',
      expected: 1,
      required: true,
      docs: [
        {
          id: 'd4',
          name: 'itemised-bill.pdf',
          amountPaise: null,
          uploadedBy: 'Madhura',
          uploadedAt: '2026-10-22T18:02:00Z',
        },
      ],
    },
    {
      id: 'i4',
      label: 'Discharge summary',
      kind: 'record',
      expected: 1,
      required: true,
      docs: [
        {
          id: 'd5',
          name: 'discharge-summary.pdf',
          amountPaise: null,
          uploadedBy: 'Shruti',
          uploadedAt: '2026-10-22T18:30:00Z',
        },
      ],
    },
    {
      id: 'i5',
      label: 'Pharmacy bills',
      kind: 'bill',
      expected: 5,
      required: true,
      docs: [
        {
          id: 'd6',
          name: 'pharmacy-14oct.jpg',
          amountPaise: 11_200_00,
          uploadedBy: 'Shruti',
          uploadedAt: '2026-10-23T07:15:00Z',
        },
        {
          id: 'd7',
          name: 'pharmacy-16oct.jpg',
          amountPaise: 9_300_00,
          uploadedBy: 'Shruti',
          uploadedAt: '2026-10-23T07:16:00Z',
        },
        {
          id: 'd8',
          name: 'pharmacy-18oct.jpg',
          amountPaise: 6_200_00,
          uploadedBy: 'Madhura',
          uploadedAt: '2026-11-11T20:44:00Z',
          pending: true,
        },
      ],
    },
    {
      id: 'i6',
      label: 'Doctor prescriptions',
      kind: 'record',
      expected: 2,
      required: true,
      docs: [
        {
          id: 'd9',
          name: 'prescription-1.jpg',
          amountPaise: null,
          uploadedBy: 'Shruti',
          uploadedAt: '2026-10-23T07:20:00Z',
        },
        {
          id: 'd10',
          name: 'prescription-2.jpg',
          amountPaise: null,
          uploadedBy: 'Shruti',
          uploadedAt: '2026-10-23T07:21:00Z',
        },
      ],
    },
    {
      id: 'i7',
      label: 'Lab and investigation reports',
      kind: 'record',
      expected: null,
      required: true,
      docs: [],
    },
    {
      id: 'i8',
      label: 'Cancelled cheque',
      kind: 'record',
      expected: 1,
      required: true,
      docs: [],
    },
    {
      id: 'i9',
      label: 'ID proof',
      kind: 'record',
      expected: 1,
      required: true,
      docs: [
        {
          id: 'd11',
          name: 'aadhaar-front.jpg',
          amountPaise: null,
          uploadedBy: 'Madhura',
          uploadedAt: '2026-10-21T09:15:00Z',
        },
      ],
    },
  ],
}
