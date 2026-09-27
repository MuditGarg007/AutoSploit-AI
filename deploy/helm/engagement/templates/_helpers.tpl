{{/*
Helper templates for the per-engagement chart (docs/orchestration.md §6).

Mirrors k8s/manifests.py: `engagement_labels(id, role)`. Object names are FIXED
and unprefixed (no `{{ .Release.Name }}-`) — see Chart.yaml and the target Service
DNS contract (M6a). So there is deliberately no `fullname` helper here.
*/}}

{{/* Common labels on every object: the engagement id. */}}
{{- define "engagement.labels" -}}
engagement: {{ .Values.engagementId | quote }}
{{- end -}}

{{/* Common labels plus a role (attacker/target), matching engagement_labels(). */}}
{{- define "engagement.roleLabels" -}}
engagement: {{ .Values.engagementId | quote }}
role: {{ .role | quote }}
{{- end -}}
