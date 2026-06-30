{{- define "kravn.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kravn.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "kravn.labels" -}}
app.kubernetes.io/name: {{ include "kravn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "kravn.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kravn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kravn.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{/*
Database env shared by the app Deployment and the migration Job: KRAVN_DB_SCHEMA + DATABASE_URL.
Keeps both in sync so the Job migrates the exact database the pods connect to.
*/}}
{{- define "kravn.dbEnv" -}}
{{- if .Values.database.schema }}
- name: KRAVN_DB_SCHEMA
  value: {{ .Values.database.schema | quote }}
{{- end }}
{{- if .Values.database.enabled }}
- name: DATABASE_URL
  {{- if .Values.database.existingSecret }}
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.existingSecret }}
      key: {{ .Values.database.existingSecretKey }}
  {{- else }}
  value: {{ .Values.database.url | quote }}
  {{- end }}
{{- else if .Values.postgres.enabled }}
- name: DATABASE_URL
  {{- if .Values.postgres.existingSecret }}
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgres.existingSecret }}
      key: {{ .Values.postgres.existingSecretKey }}
  {{- else }}
  value: {{ .Values.postgres.url | quote }}
  {{- end }}
{{- end }}
{{- end -}}
