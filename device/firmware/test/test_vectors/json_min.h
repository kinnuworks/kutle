/* Minimal JSON reader for the native test: enough to walk test-vectors.json.
 * Numbers are kept as their source text. Not for untrusted input. */
#ifndef JSON_MIN_H
#define JSON_MIN_H

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } jtype;

typedef struct jnode {
  jtype type;
  char *key;  /* member name when inside an object */
  char *text; /* string contents or number text */
  struct jnode *child, *next;
} jnode;

static const char *jp;

static void jws(void) {
  while (isspace((unsigned char)*jp)) jp++;
}

static char *jstr(void) {
  /* test-vectors.json has no escapes other than none; keep it simple */
  const char *s = ++jp;
  while (*jp && *jp != '"') {
    if (*jp == '\\') jp++;
    jp++;
  }
  size_t n = (size_t)(jp - s);
  char *out = (char *)malloc(n + 1);
  memcpy(out, s, n);
  out[n] = 0;
  jp++;
  return out;
}

static jnode *jvalue(void) {
  jnode *n = (jnode *)calloc(1, sizeof *n);
  jws();
  if (*jp == '{' || *jp == '[') {
    char close = *jp == '{' ? '}' : ']';
    n->type = *jp == '{' ? J_OBJ : J_ARR;
    jp++;
    jnode **tail = &n->child;
    jws();
    while (*jp != close) {
      char *key = NULL;
      if (n->type == J_OBJ) {
        key = jstr();
        jws();
        jp++; /* ':' */
      }
      jnode *c = jvalue();
      c->key = key;
      *tail = c;
      tail = &c->next;
      jws();
      if (*jp == ',') jp++;
      jws();
    }
    jp++;
  } else if (*jp == '"') {
    n->type = J_STR;
    n->text = jstr();
  } else if (!strncmp(jp, "true", 4) || !strncmp(jp, "false", 5)) {
    n->type = J_BOOL;
    n->text = (char *)(*jp == 't' ? "true" : "false");
    jp += *jp == 't' ? 4 : 5;
  } else if (!strncmp(jp, "null", 4)) {
    n->type = J_NULL;
    jp += 4;
  } else {
    const char *s = jp;
    while (*jp && (isdigit((unsigned char)*jp) || *jp == '-' || *jp == '+' || *jp == '.' || *jp == 'e' || *jp == 'E'))
      jp++;
    size_t len = (size_t)(jp - s);
    n->type = J_NUM;
    n->text = (char *)malloc(len + 1);
    memcpy(n->text, s, len);
    n->text[len] = 0;
  }
  return n;
}

static jnode *json_parse(const char *src) {
  jp = src;
  return jvalue();
}

static jnode *jget(const jnode *o, const char *key) {
  for (jnode *c = o ? o->child : NULL; c; c = c->next)
    if (c->key && !strcmp(c->key, key)) return c;
  return NULL;
}

static jnode *jat(const jnode *a, size_t i) {
  jnode *c = a ? a->child : NULL;
  while (c && i--) c = c->next;
  return c;
}

static size_t jlen(const jnode *a) {
  size_t n = 0;
  for (jnode *c = a ? a->child : NULL; c; c = c->next) n++;
  return n;
}

static const char *jstrv(const jnode *o, const char *key) {
  jnode *n = jget(o, key);
  return n ? n->text : NULL;
}

static long long jnum(const jnode *o, const char *key) {
  jnode *n = jget(o, key);
  return n && n->text ? strtoll(n->text, NULL, 10) : 0;
}

#endif
