/**
 * The payroll export port (scheduling.md section 18 rule 14; SCHED-008 is slice 76). A locked
 * run's lines are offered here and through the `scheduling.pay_run_locked` outbox event; nothing
 * is sent anywhere until slice 76 adds an adapter (Xero Payroll first), which joins the
 * sub-processor register and the DPIA before it receives personal data.
 */
export interface PayrollExportPort {
  offer(run: {
    readonly id: string;
    readonly frequency: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly kind: string;
    readonly lineIds: readonly string[];
  }): Promise<void>;
}

/** No adapter yet: the run waits for slice 76, which reads locked runs from the outbox. */
export const payrollExportNotConfigured: PayrollExportPort = {
  async offer() {},
};
