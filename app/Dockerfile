FROM php:8.3.30-apache-bookworm@sha256:daf3cad5642798e462a029e41d6347cba7f3362f7028f8e60c3623dbadc4e590

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev \
    && docker-php-ext-install pdo_pgsql \
    && a2enmod rewrite headers

COPY app/apache.conf /etc/apache2/sites-available/000-default.conf
COPY app/php.ini /usr/local/etc/php/conf.d/billeterie.ini
COPY app/public/ /var/www/html/public/
COPY app/src/ /var/www/html/src/

EXPOSE 80
