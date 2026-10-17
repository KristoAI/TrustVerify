<?php
/**
 * Plugin Name: TrustBunny Age Gate
 * Description: Adds a branded TrustBunny browser age gate to your WordPress site.
 * Version: 0.1.0
 * License: AGPL-3.0-or-later
 */
if (!defined('ABSPATH')) { exit; }
add_action('admin_menu', function () {
    add_options_page('TrustBunny', 'TrustBunny', 'manage_options', 'trustverify', 'trustverify_settings_page');
});
add_action('admin_init', function () {
    register_setting('trustverify', 'trustverify_options', array('type' => 'array', 'sanitize_callback' => 'trustverify_sanitize_options'));
});
function trustverify_sanitize_options($input) {
    $url = esc_url_raw(isset($input['origin']) ? trim($input['origin']) : '', array('https'));
    $parts = wp_parse_url($url);
    if (!$parts || empty($parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment']) || (!empty($parts['path']) && $parts['path'] !== '/')) {
        add_settings_error('trustverify', 'invalid_origin', 'Enter the HTTPS origin of your TrustBunny service, without a path.');
        return get_option('trustverify_options', array());
    }
    $site = isset($input['site']) ? sanitize_text_field($input['site']) : '';
    if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $site)) {
        add_settings_error('trustverify', 'invalid_site', 'Enter the site ID from your TrustBunny dashboard.');
        return get_option('trustverify_options', array());
    }
    return array('origin' => untrailingslashit($url), 'site' => $site, 'enabled' => !empty($input['enabled']));
}
function trustverify_settings_page() {
    if (!current_user_can('manage_options')) { return; }
    $options = get_option('trustverify_options', array());
    ?>
    <div class="wrap"><h1>TrustBunny Age Gate</h1>
    <p>Register this site's exact origin in TrustBunny and choose a return page that loads this plugin. Policies, branding, and proof freshness are managed in the TrustBunny dashboard.</p>
    <p><strong>This plugin displays a browser gate. It does not protect content, feeds, downloads, or REST responses on the server.</strong> Use a server API integration when restricted content must not be delivered before verification.</p>
    <?php settings_errors(); ?>
    <form action="options.php" method="post"><?php settings_fields('trustverify'); ?>
    <table class="form-table"><tr><th><label for="tv-origin">TrustBunny HTTPS origin</label></th><td><input class="regular-text" id="tv-origin" name="trustverify_options[origin]" type="url" required value="<?php echo esc_attr(isset($options['origin']) ? $options['origin'] : ''); ?>" placeholder="https://trustbunny.com"></td></tr>
    <tr><th><label for="tv-site">Site ID</label></th><td><input class="regular-text" id="tv-site" name="trustverify_options[site]" required value="<?php echo esc_attr(isset($options['site']) ? $options['site'] : ''); ?>"></td></tr>
    <tr><th>Enable gate</th><td><label><input name="trustverify_options[enabled]" type="checkbox" value="1" <?php checked(!empty($options['enabled'])); ?>> Enable on public pages</label></td></tr></table>
    <?php submit_button(); ?></form><p>No API key or visitor email is needed for the embedded gate.</p></div>
    <?php
}
add_action('wp_enqueue_scripts', function () {
    $options = get_option('trustverify_options', array());
    if (empty($options['enabled']) || empty($options['origin']) || empty($options['site']) || is_admin()) { return; }
    wp_enqueue_script('trustverify-gate', $options['origin'] . '/gate.js', array(), '1', true);
});
add_filter('script_loader_tag', function ($tag, $handle) {
    if ($handle !== 'trustverify-gate') { return $tag; }
    $options = get_option('trustverify_options', array());
    return str_replace('<script ', '<script defer data-site="' . esc_attr($options['site']) . '" ', $tag);
}, 10, 2);
