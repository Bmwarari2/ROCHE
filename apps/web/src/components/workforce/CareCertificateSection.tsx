import { Card } from "@harbour/ui";
import { recordCareCertificateStep } from "@/app/actions/workforce";
import { SafetyChip } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { t } from "@/lib/i18n";
import { standardChip, ukDate } from "@/lib/workforce";

interface CareCertificate {
  readonly complete: boolean;
  readonly completedOn: string | null;
  readonly competent: number;
  readonly standards: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
  }[];
}

/**
 * The Care Certificate's 16 standards (workforce.md rule 20; ids and short titles only, H-531),
 * each with its status as an icon and a word, and the step the viewer may record: the knowledge
 * assessment (`assess`), then the observation in practice (`observe`, which needs only
 * `workforce.competence.observe`). Shown on the induction and on the training record, so that
 * team leaders and clinical leads, who observe without the staff file, can record it.
 */
export function CareCertificateSection({
  profileId,
  careCertificate,
  assess,
  observe,
  path,
}: {
  readonly profileId: string;
  readonly careCertificate: CareCertificate;
  readonly assess: boolean;
  readonly observe: boolean;
  readonly path: string;
}) {
  return (
    <section aria-labelledby="care-certificate" className="flex flex-col gap-3">
      <h2 id="care-certificate" className="m-0 text-heading-3 font-semibold">
        {t("workforce.careCertificate.title")}
      </h2>
      <p className="m-0 text-body-dense">
        {careCertificate.complete
          ? t("workforce.careCertificate.complete", {
              date: ukDate(careCertificate.completedOn),
            })
          : t("workforce.careCertificate.progress", { count: careCertificate.competent })}
      </p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {careCertificate.standards.map((s) => (
          <li key={s.id}>
            <Card>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="m-0 text-body font-semibold">{s.title}</h3>
                  <SafetyChip chip={standardChip(s.status, t)} />
                </div>
                {assess && s.status === "not_started" ? (
                  <WorkforceForm
                    headingLevel={4}
                    title={t("workforce.careCertificate.assess", { standard: s.title })}
                    path={path}
                    submit={t("workforce.careCertificate.assess", { standard: s.title })}
                    done="workforce.careCertificate.assessed"
                    action={recordCareCertificateStep.bind(null, profileId, s.id, "knowledge")}
                    fields={[
                      {
                        kind: "date",
                        name: "on",
                        label: t("workforce.careCertificate.assessedOn"),
                        required: true,
                      },
                    ]}
                  />
                ) : null}
                {observe && s.status === "knowledge_assessed" ? (
                  <WorkforceForm
                    headingLevel={4}
                    title={t("workforce.careCertificate.observe", { standard: s.title })}
                    path={path}
                    submit={t("workforce.careCertificate.observe", { standard: s.title })}
                    done="workforce.careCertificate.observed"
                    action={recordCareCertificateStep.bind(null, profileId, s.id, "observation")}
                    fields={[
                      {
                        kind: "date",
                        name: "on",
                        label: t("workforce.careCertificate.observedOn"),
                        required: true,
                      },
                    ]}
                  />
                ) : null}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
