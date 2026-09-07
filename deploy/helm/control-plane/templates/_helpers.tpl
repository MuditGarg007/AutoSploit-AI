{{/*
Helper templates for the control-plane chart (docs/component-h-hardening.md §8.2).
*/}}
{{- define "control-plane.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "control-plane.serviceAccountName" -}}
{{- if .Values.serviceAccount.name -}}
{{- .Values.serviceAccount.name -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name "control-plane" | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}